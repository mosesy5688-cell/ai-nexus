/**
 * V25.8 Rust FFI Bridge — Graceful fallback to JS implementations.
 *
 * Attempts to load .node binaries. If unavailable (dev/CI without Rust build),
 * falls back to equivalent JS modules transparently.
 *
 * Spec §5.2: Async N-API Implant Map
 * - shard-router-rust.node       → computeShardSlot, batchComputeShardSlots
 * - fni-calc-rust.node            → batchCalculateFni
 * - mesh-engine-rust.node         → computeHubScores
 * - content-extractor-rust.node   → extractAndClassify, classifyText
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let _shardRouter = null;
let _fniCalc = null;
let _meshEngine = null;
let _contentExtractor = null;
let _mode = 'js'; // 'rust' or 'js'

function tryLoadNative(name) {
    try {
        const mod = require(`../../../rust/${name.replace('-rust', '')}/${name}.node`);
        return mod;
    } catch {
        return null;
    }
}

/**
 * Initialize Rust bridge. Call once at startup.
 * Returns { mode: 'rust' | 'js', modules: string[] }
 */
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

    _mode = loaded.length > 0 ? 'rust' : 'js';
    console.log(`[RUST-BRIDGE] Mode: ${_mode} | Loaded: ${loaded.length > 0 ? loaded.join(', ') : 'none (JS fallback)'}`);
    return { mode: _mode, modules: loaded };
}

/**
 * Compute shard slot via xxhash64 (Rust) or 32-bit approximation (JS).
 */
export function computeShardSlotFFI(umid, totalSlots = 4096) {
    if (_shardRouter) {
        return _shardRouter.computeShardSlot(umid, totalSlots);
    }
    // JS fallback: 32-bit approximation (sync require for non-async context)
    const { computeShardSlot } = require('./umid-generator.js');
    return computeShardSlot(umid, totalSlots);
}

/**
 * Batch shard slot computation.
 * @param {string[]} umids - Array of UMID strings
 * @param {number} totalSlots
 * @returns {number[]} Slot IDs
 */
export function batchComputeShardSlotsFFI(umids, totalSlots = 4096) {
    if (_shardRouter) {
        const buffer = Buffer.from(umids.join('\n'));
        return _shardRouter.batchComputeShardSlots(buffer, totalSlots);
    }
    // JS fallback
    const { computeShardSlot } = require('./umid-generator.js');
    return umids.map(u => computeShardSlot(u, totalSlots));
}

/**
 * Batch FNI calculation.
 * @param {Array} entities - Pre-processed entity objects
 * @returns {Array} FNI results
 */
export function batchCalculateFniFFI(entities) {
    if (_fniCalc) {
        const buffer = Buffer.from(JSON.stringify(entities));
        return _fniCalc.batchCalculateFni(buffer);
    }
    // JS fallback
    const { calculateFNI } = require('./fni-score.js');
    return entities.map(e => {
        const result = calculateFNI(e, { includeMetrics: true });
        return {
            id: e.id,
            fni_score: result.score,
            raw_pop: result.rawPop || 0,
            sp: result.metrics.p,
            sf: result.metrics.f,
            sm: result.metrics.v,
        };
    });
}

/**
 * Compute hub scores via Rust mesh engine.
 * @param {Array} edges - { from, to, source_type }
 * @param {Array} nodes - { id, fni_score, days_since_update }
 * @returns {Array} Hub score results
 */
export function computeHubScoresFFI(edges, nodes) {
    if (_meshEngine) {
        const edgesBuf = Buffer.from(JSON.stringify(edges));
        const nodesBuf = Buffer.from(JSON.stringify(nodes));
        return _meshEngine.computeHubScores(edgesBuf, nodesBuf);
    }
    // JS fallback
    const { calculateHubScore } = require('./hub-scorer.js');
    return nodes.map(n => ({
        id: n.id,
        hub_score: calculateHubScore(n, { inDegree: 0, outDegree: 0 }),
        pagerank: 0,
        in_degree: 0,
        out_degree: 0,
        weighted_citations: 0,
    }));
}

/**
 * V25.8.3: Extract content from ar5iv HTML and classify (4-bucket).
 * Rust: regex-based HTML→Markdown + classification in native code.
 * JS fallback: uses ar5iv-fetcher.js extractMainContent equivalent.
 * @param {string} html - Raw HTML from ar5iv
 * @returns {{ text: string, classification: string, charCount: number, sectionCount: number, hasFulltext: boolean }}
 */
export function extractAndClassifyFFI(html) {
    if (_contentExtractor) {
        const r = _contentExtractor.extractAndClassify(html);
        return { text: r.text, classification: r.classification,
            charCount: r.charCount, sectionCount: r.sectionCount, hasFulltext: r.hasFulltext };
    }
    // JS fallback: inline extraction + classification
    return _jsFallbackExtract(html);
}

/**
 * V25.8.3: Classify pre-extracted text (no HTML parsing needed).
 * @param {string} text - Already extracted text
 * @returns {{ text: string, classification: string, charCount: number, sectionCount: number, hasFulltext: boolean }}
 */
export function classifyTextFFI(text) {
    if (_contentExtractor) {
        const r = _contentExtractor.classifyText(text);
        return { text: r.text, classification: r.classification,
            charCount: r.charCount, sectionCount: r.sectionCount, hasFulltext: r.hasFulltext };
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

/**
 * V25.8.3 §3.2: Build enrichment manifest from R2 key list (Rust).
 * Extracts UMID from R2 keys matching enrichment/fulltext/{xx}/{umid}.md.gz.
 * @param {string[]} keys - Array of R2 object keys
 * @returns {Map<string, string>} umid -> R2 key
 */
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

/**
 * V25.8.3 §3.2: Validate fusion content quality (Rust).
 * Ensures injected fulltext passes dual-signal threshold before packing.
 * @param {string} fulltext - Downloaded enriched text
 * @param {string} originalBody - Existing body_content
 * @returns {{ text: string, hasFulltext: boolean, classification: string }}
 */
export function validateFusionContentFFI(fulltext, originalBody) {
    if (_contentExtractor) {
        const r = _contentExtractor.validateFusionContent(fulltext, originalBody);
        return { text: r.text, hasFulltext: r.hasFulltext, classification: r.classification };
    }
    // JS fallback
    if (fulltext.length <= originalBody.length) return _jsFallbackClassify(originalBody);
    return _jsFallbackClassify(fulltext);
}

export function getRustMode() {
    return _mode;
}
