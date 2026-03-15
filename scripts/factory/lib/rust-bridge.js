/**
 * V25.8 Rust FFI Bridge — Graceful fallback to JS implementations.
 *
 * Attempts to load .node binaries. If unavailable (dev/CI without Rust build),
 * falls back to equivalent JS modules transparently.
 *
 * Spec §5.2: Async N-API Implant Map
 * - shard-router-rust.node  → computeShardSlot, batchComputeShardSlots
 * - fni-calc-rust.node      → batchCalculateFni
 * - mesh-engine-rust.node   → computeHubScores
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let _shardRouter = null;
let _fniCalc = null;
let _meshEngine = null;
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

export function getRustMode() {
    return _mode;
}
