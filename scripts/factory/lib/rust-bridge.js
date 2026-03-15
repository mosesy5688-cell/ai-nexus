// V25.8 Rust FFI Bridge — Graceful fallback to JS implementations.
// Loads .node N-API binaries; falls back to JS modules if unavailable.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let _shardRouter = null;
let _fniCalc = null;
let _meshEngine = null;
let _contentExtractor = null;
let _streamAggregator = null;
let _satelliteTasks = null;
let _mode = 'js'; // 'rust' or 'js'

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

    _shardRouter = tryLoadNative('shard-router-rust');
    if (_shardRouter) loaded.push('shard-router');

    _fniCalc = tryLoadNative('fni-calc-rust');
    if (_fniCalc) loaded.push('fni-calc');

    _meshEngine = tryLoadNative('mesh-engine-rust');
    if (_meshEngine) loaded.push('mesh-engine');

    _contentExtractor = tryLoadNative('content-extractor-rust');
    if (_contentExtractor) loaded.push('content-extractor');

    _streamAggregator = tryLoadNative('stream-aggregator-rust');
    if (_streamAggregator) loaded.push('stream-aggregator');

    _satelliteTasks = tryLoadNative('satellite-tasks-rust');
    if (_satelliteTasks) loaded.push('satellite-tasks');

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

/** Batch FNI calculation. */
export function batchCalculateFniFFI(entities) {
    if (_fniCalc) {
        const buffer = Buffer.from(JSON.stringify(entities));
        return _fniCalc.batchCalculateFni(buffer);
    }
    const { calculateFNI } = require('./fni-score.js');
    return entities.map(e => {
        const r = calculateFNI(e, { includeMetrics: true });
        return { id: e.id, fni_score: r.score, raw_pop: r.rawPop || 0, sp: r.metrics.p, sf: r.metrics.f, sm: r.metrics.v };
    });
}

/** Compute hub scores via Rust mesh engine. */
export function computeHubScoresFFI(edges, nodes) {
    if (_meshEngine) return _meshEngine.computeHubScores(Buffer.from(JSON.stringify(edges)), Buffer.from(JSON.stringify(nodes)));
    const { calculateHubScore } = require('./hub-scorer.js');
    return nodes.map(n => ({ id: n.id, hub_score: calculateHubScore(n, { inDegree: 0, outDegree: 0 }), pagerank: 0, in_degree: 0, out_degree: 0, weighted_citations: 0 }));
}

/** Extract content from ar5iv HTML and classify (4-bucket). */
export function extractAndClassifyFFI(html) {
    if (_contentExtractor) {
        const r = _contentExtractor.extractAndClassify(html);
        return { text: r.text, classification: r.classification, charCount: r.charCount, sectionCount: r.sectionCount, hasFulltext: r.hasFulltext };
    }
    return _jsFallbackExtract(html);
}

/** Classify pre-extracted text. */
export function classifyTextFFI(text) {
    if (_contentExtractor) {
        const r = _contentExtractor.classifyText(text);
        return { text: r.text, classification: r.classification, charCount: r.charCount, sectionCount: r.sectionCount, hasFulltext: r.hasFulltext };
    }
    return _jsFallbackClassify(text);
}

function _jsFallbackExtract(html) {
    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '');
    text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, c) =>
        `\n${'#'.repeat(parseInt(l))} ${c.replace(/<[^>]+>/g, '').trim()}\n`);
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c) =>
        c.replace(/<[^>]+>/g, '').trim() + '\n\n');
    text = text.replace(/<[^>]+>/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return _jsFallbackClassify(text);
}

function _jsFallbackClassify(text) {
    const sectionCount = (text.match(/^#{2,3}\s+\S/gm) || []).length;
    const charCount = text.length;
    let classification, hasFulltext;
    if (charCount >= 1000 && sectionCount >= 2) { classification = 'SUCCESS'; hasFulltext = true; }
    else if (charCount >= 200) { classification = 'PARTIAL'; hasFulltext = false; }
    else { classification = 'SKIP'; hasFulltext = false; }
    return { text, classification, charCount, sectionCount, hasFulltext };
}

/** Build enrichment manifest from R2 key list. */
export function buildEnrichmentManifestFFI(keys) {
    const manifest = new Map();
    if (_contentExtractor) {
        const buffer = Buffer.from(keys.join('\n'));
        const pairs = _contentExtractor.buildEnrichmentManifest(buffer);
        for (const [umid, key] of pairs) manifest.set(umid, key);
    } else {
        const re = /enrichment\/fulltext\/[a-f0-9]{2}\/([a-f0-9]+)\.md\.gz$/;
        for (const key of keys) {
            const m = key.match(re);
            if (m) manifest.set(m[1], key);
        }
    }
    return manifest;
}

/** Validate fusion content quality. */
export function validateFusionContentFFI(fulltext, originalBody) {
    if (_contentExtractor) {
        const r = _contentExtractor.validateFusionContent(fulltext, originalBody);
        return { text: r.text, hasFulltext: r.hasFulltext, classification: r.classification };
    }
    if (fulltext.length <= originalBody.length) return _jsFallbackClassify(originalBody);
    return _jsFallbackClassify(fulltext);
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

/** V25.8.3: Satellite task FFI — search index builder. */
export function buildSearchIndexFFI(entitiesJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.buildSearchIndex(entitiesJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildSearchIndex failed: ${e.message}. JS fallback.`); return null; }
    }
    return null;
}

/** V25.8.3: Satellite task FFI — relations graph builder. */
export function buildRelationsGraphFFI(nodesJson, relationsJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.buildRelationsGraph(nodesJson, relationsJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildRelationsGraph failed: ${e.message}. JS fallback.`); return null; }
    }
    return null;
}

/** V25.8.3: Satellite task FFI — knowledge linker. */
export function computeKnowledgeLinksFFI(entitiesJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.computeKnowledgeLinks(entitiesJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] computeKnowledgeLinks failed: ${e.message}. JS fallback.`); return null; }
    }
    return null;
}

/** V25.8.3: Satellite task FFI — alt linker (Jaccard similarity). */
export function computeAltRelationsFFI(entitiesJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.computeAltRelations(entitiesJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] computeAltRelations failed: ${e.message}. JS fallback.`); return null; }
    }
    return null;
}

/** V25.8.3: Satellite task FFI — mesh graph builder. */
export function buildMeshGraphFFI(explicitJson, knowledgeLinksJson, reportsJson) {
    if (_satelliteTasks) {
        try { return _satelliteTasks.buildMeshGraph(explicitJson, knowledgeLinksJson, reportsJson); }
        catch (e) { console.warn(`[RUST-BRIDGE] buildMeshGraph failed: ${e.message}. JS fallback.`); return null; }
    }
    return null;
}

export function getRustMode() {
    return _mode;
}
