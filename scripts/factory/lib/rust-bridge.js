// V26.5 Rust FFI Bridge — Loads .node N-API binaries; falls back to JS.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let _shardRouter = null, _fniCalc = null, _meshEngine = null;
let _contentExtractor = null, _streamAggregator = null, _satelliteTasks = null;
let _mode = 'js';

function tryLoadNative(name) {
    try {
        const mod = require(`../../../rust/${name.replace('-rust', '')}/${name}.node`);
        return mod;
    } catch {
        return null;
    }
}

/** Initialize Rust bridge. Call once at startup. */
export function initRustBridge() {
    const loaded = [];

    for (const [name, setter] of [['shard-router', v => _shardRouter = v], ['fni-calc', v => _fniCalc = v], ['mesh-engine', v => _meshEngine = v], ['content-extractor', v => _contentExtractor = v], ['stream-aggregator', v => _streamAggregator = v], ['satellite-tasks', v => _satelliteTasks = v]]) {
        const mod = tryLoadNative(`${name}-rust`);
        if (mod) { setter(mod); loaded.push(name); }
    }

    _mode = loaded.length > 0 ? 'rust' : 'js';
    console.log(`[RUST-BRIDGE] Mode: ${_mode} | Loaded: ${loaded.length > 0 ? loaded.join(', ') : 'none (JS fallback)'}`);
    return { mode: _mode, modules: loaded };
}

/** Compute shard slot via xxhash64 (Rust) or JS fallback. */
export function computeShardSlotFFI(umid, totalSlots = 4096) {
    if (_shardRouter) return _shardRouter.computeShardSlot(umid, totalSlots);
    const { computeShardSlot } = require('./umid-generator.js');
    return computeShardSlot(umid, totalSlots);
}

/** Batch shard slot computation. */
export function batchComputeShardSlotsFFI(umids, totalSlots = 4096) {
    if (_shardRouter) return _shardRouter.batchComputeShardSlots(Buffer.from(umids.join('\n')), totalSlots);
    const { computeShardSlot } = require('./umid-generator.js');
    return umids.map(u => computeShardSlot(u, totalSlots));
}

/** Batch FNI calculation (pre-extracted inputs). */
export function batchCalculateFniFFI(entities) {
    if (_fniCalc) return _fniCalc.batchCalculateFni(Buffer.from(JSON.stringify(entities)));
    const { calculateFNI } = require('./fni-score.js');
    return entities.map(e => {
        const r = calculateFNI(e, { includeMetrics: true });
        return { id: e.id, fni_score: r.score, raw_pop: r.rawPop || 0, s: r.metrics.s, a: r.metrics.a, p: r.metrics.p, r: r.metrics.r, q: r.metrics.q };
    });
}

let _fniModeLogged = false;
/** Single entity FNI: Rust FFI (primary) or JS (fallback). Per-entity, no batching — safe for streaming. */
export function calculateFniFFI(entity, options = {}) {
    const { extractFniInput, calculateFNI } = require('./fni-score.js');
    if (!_fniModeLogged) { console.log(`[FNI-CALC] Mode: ${_fniCalc ? 'Rust V2.0' : 'JS V2.0 (fallback)'}`); _fniModeLogged = true; }
    if (_fniCalc) {
        const i = extractFniInput(entity, options);
        const r = _fniCalc.calculateFniSingle(i.id, i.entity_type, i.raw_metrics, i.completeness, i.utility, i.days_since_update, i.date_valid, i.mesh_points);
        return { score: r.fniScore, rawPop: r.rawPop, metrics: { s: r.s, a: r.a, p: r.p, r: r.r, q: r.q } };
    }
    return calculateFNI(entity, options);
}

/** Compute hub scores via Rust mesh engine. */
export function computeHubScoresFFI(edges, nodes) {
    if (_meshEngine) return _meshEngine.computeHubScores(Buffer.from(JSON.stringify(edges)), Buffer.from(JSON.stringify(nodes)));
    const { calculateHubScore } = require('./hub-scorer.js');
    return nodes.map(n => ({ id: n.id, hub_score: calculateHubScore(n, { inDegree: 0, outDegree: 0 }), pagerank: 0, in_degree: 0, out_degree: 0, weighted_citations: 0 }));
}

/** Extract content from ar5iv HTML and classify (4-bucket). */
export function extractAndClassifyFFI(html) {
    if (_contentExtractor) { const r = _contentExtractor.extractAndClassify(html); return { text: r.text, classification: r.classification, charCount: r.charCount, sectionCount: r.sectionCount, hasFulltext: r.hasFulltext }; }
    return _jsFallbackExtract(html);
}

/** Classify pre-extracted text. */
export function classifyTextFFI(text) {
    if (_contentExtractor) { const r = _contentExtractor.classifyText(text); return { text: r.text, classification: r.classification, charCount: r.charCount, sectionCount: r.sectionCount, hasFulltext: r.hasFulltext }; }
    return _jsFallbackClassify(text);
}

function _jsFallbackExtract(html) {
    let t = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<header[\s\S]*?<\/header>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '');
    t = t.replace(/<(?:h[1-6]|span|div)[^>]*class=["'][^"']*ltx_title[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi, '\n## $1\n');
    t = t.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, c) => `\n${'#'.repeat(parseInt(l))} ${c.replace(/<[^>]+>/g, '').trim()}\n`);
    t = t.replace(/<(?:p|div)[^>]*class=["'][^"']*ltx_p[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi, '$1\n\n');
    t = t.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => c.replace(/<[^>]+>/g, '').trim() + '\n\n');
    return _jsFallbackClassify(t.replace(/<[^>]+>/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
}

function _jsFallbackClassify(text) {
    const sc = (text.match(/^#{2,3}\s+\S/gm) || []).length, cc = text.length;
    const [classification, hasFulltext] = cc >= 1000 && sc >= 2 ? ['SUCCESS', true] : cc >= 200 ? ['PARTIAL', false] : ['SKIP', false];
    return { text, classification, charCount: cc, sectionCount: sc, hasFulltext };
}

/** Build enrichment manifest from R2 key list. */
export function buildEnrichmentManifestFFI(keys) {
    const manifest = new Map();
    if (_contentExtractor) { for (const [u, k] of _contentExtractor.buildEnrichmentManifest(Buffer.from(keys.join('\n')))) manifest.set(u, k); }
    else { const re = /enrichment\/fulltext\/[a-f0-9]{2}\/([a-f0-9]+)\.md\.gz$/; for (const k of keys) { const m = k.match(re); if (m) manifest.set(m[1], k); } }
    return manifest;
}

/** Validate fusion content quality. */
export function validateFusionContentFFI(fulltext, originalBody) {
    if (_contentExtractor) { const r = _contentExtractor.validateFusionContent(fulltext, originalBody); return { text: r.text, hasFulltext: r.hasFulltext, classification: r.classification }; }
    return _jsFallbackClassify(fulltext.length > originalBody.length ? fulltext : originalBody);
}

/** V55.9: Zstd file/buffer compress/decompress via Rust. */
export function zstdCompressFileFFI(inputPath, outputPath, level = 3) {
    return _streamAggregator?.zstdCompressFile?.(inputPath, outputPath, level) ?? null;
}
export function zstdCompressBufferFFI(data, level = 3) {
    return _streamAggregator?.zstdCompressBuffer?.(data, level) ?? null;
}
export function zstdDecompressBufferFFI(data) {
    return _streamAggregator?.zstdDecompressBuffer?.(data) ?? null;
}
export function zstdDecompressFileFFI(inputPath, outputPath) {
    return _streamAggregator?.zstdDecompressFile?.(inputPath, outputPath) ?? null;
}

/** Streaming shard aggregation (Rust). OOM-safe for 400K+ entities. */
export function streamAggregateFFI(shardDir, outputPath) {
    if (_streamAggregator) {
        try {
            return _streamAggregator.streamAggregate(shardDir, outputPath);
        } catch (e) {
            console.warn(`[RUST-BRIDGE] streamAggregate failed: ${e.message}. Falling back to JS.`);
            return null;
        }
    }
    return null;
}

/** V26.5: Search index — prefer direct shard reading, fallback to Buffer. */
export function buildSearchIndexFromDirFFI(shardDir, outputDir) {
    if (_satelliteTasks?.buildSearchIndexFromDir) {
        try { return _satelliteTasks.buildSearchIndexFromDir(shardDir, outputDir); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildSearchIndexFromDir: ${e.message}`); }
    }
    return null;
}
export function buildSearchIndexFFI(entitiesJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.buildSearchIndex(entitiesJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildSearchIndex: ${e.message}`); return null; }
    }
    return null;
}

/** V26.5: Relations graph — prefer file reading, fallback to Buffer. */
export function buildRelationsGraphFromFilesFFI(nodesPath, relationsPath, outputDir) {
    if (_satelliteTasks?.buildRelationsGraphFromFiles) {
        try { return _satelliteTasks.buildRelationsGraphFromFiles(nodesPath, relationsPath, outputDir); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildRelationsGraphFromFiles: ${e.message}`); }
    }
    return null;
}
export function buildRelationsGraphFFI(nodesJson, relationsJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.buildRelationsGraph(nodesJson, relationsJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildRelationsGraph: ${e.message}`); return null; }
    }
    return null;
}

/** V26.5: Knowledge linker — prefer direct shard reading. */
export function computeKnowledgeLinksFromDirFFI(shardDir, outputDir) {
    if (_satelliteTasks?.computeKnowledgeLinksFromDir) {
        try { return _satelliteTasks.computeKnowledgeLinksFromDir(shardDir, outputDir); }
        catch (e) { console.warn(`[RUST-BRIDGE] computeKnowledgeLinksFromDir: ${e.message}`); }
    }
    return null;
}
export function computeKnowledgeLinksFFI(entitiesJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.computeKnowledgeLinks(entitiesJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] computeKnowledgeLinks: ${e.message}`); return null; }
    }
    return null;
}

/** V26.5: Alt linker — prefer direct shard reading. */
export function computeAltRelationsFromDirFFI(shardDir, outputDir) {
    if (_satelliteTasks?.computeAltRelationsFromDir) {
        try { return _satelliteTasks.computeAltRelationsFromDir(shardDir, outputDir); }
        catch (e) { console.warn(`[RUST-BRIDGE] computeAltRelationsFromDir: ${e.message}`); }
    }
    return null;
}
export function computeAltRelationsFFI(entitiesJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.computeAltRelations(entitiesJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] computeAltRelations: ${e.message}`); return null; }
    }
    return null;
}

/** V26.5: Shard fusion — Rust-native per-shard processing for master-fusion. */
export function fuseShardFFI(shardPath, validIdsPath, thresholdsPath, enrichmentDir, outputPath) {
    if (_streamAggregator?.fuseShard) {
        try { return _streamAggregator.fuseShard(shardPath, validIdsPath, thresholdsPath, enrichmentDir, outputPath); }
        catch (e) { console.warn(`[RUST-BRIDGE] fuseShard: ${e.message}`); }
    }
    return null;
}

/** V26.5: Mesh graph — prefer file reading. */
export function buildMeshGraphFromFilesFFI(explicitPath, knowledgePath, reportsPath, outputDir) {
    if (_satelliteTasks?.buildMeshGraphFromFiles) {
        try { return _satelliteTasks.buildMeshGraphFromFiles(explicitPath, knowledgePath, reportsPath, outputDir); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildMeshGraphFromFiles: ${e.message}`); }
    }
    return null;
}
export function buildMeshGraphFFI(explicitJson, knowledgeLinksJson, reportsJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.buildMeshGraph(explicitJson, knowledgeLinksJson, reportsJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildMeshGraph: ${e.message}`); return null; }
    }
    return null;
}

/** V26.7: Pass 1 + delta routing in one Rust call. */
export function buildStatsAndRouteDeltasFFI(shardDir, artifactDir, deltaDir, outputDir) {
    if (_streamAggregator?.buildStatsAndRouteDeltas) {
        try { return _streamAggregator.buildStatsAndRouteDeltas(shardDir, artifactDir, deltaDir, outputDir); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildStatsAndRouteDeltas: ${e.message}`); }
    }
    return null;
}
export function getRustMode() { return _mode; }
