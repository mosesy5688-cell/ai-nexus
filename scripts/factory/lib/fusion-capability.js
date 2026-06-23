/**
 * W3-O1 (Founder D-89) capability handshake classification.
 *
 * Pure functions (no addon import — the raw surface is injected by the caller
 * via `parseAccountingCapability()` from rust-bridge.js) that classify the
 * Rust/NAPI parse-accounting capability into an explicit 3-value protocol +
 * engine mode. IRON RULE: a default-zero / absent field is NEVER inferred as
 * protocol 1. UNKNOWN must never silently become a positive (v1) classification.
 */

export const PARSE_ACCOUNTING_PROTOCOL_EXPECTED = 1;

/**
 * Classify the raw capability surface returned by `parseAccountingCapability()`.
 * @param {{protocolConstant?:number, hasFuseShard?:boolean, engineMode?:string}} cap
 * @returns {{engine_mode:'rust'|'js', protocol:1|'legacy'|'unavailable', reason:string}}
 */
export function classifyCapability(cap) {
    const c = cap || {};
    const engine_mode = c.engineMode === 'rust' ? 'rust' : 'js';

    // JS fallback engine: no Rust addon at all -> protocol unavailable.
    if (engine_mode !== 'rust') {
        return { engine_mode, protocol: 'unavailable', reason: 'js_fallback_no_addon' };
    }
    // Rust addon present but the monitored fuseShard export is missing.
    if (!c.hasFuseShard) {
        return { engine_mode, protocol: 'unavailable', reason: 'rust_addon_no_fuse_shard' };
    }
    // Rust addon present but WITHOUT the protocol export = a legacy .node that
    // predates W3-O1. Distinct from 'unavailable' — the engine IS Rust+fuseShard.
    if (typeof c.protocolConstant !== 'number') {
        return { engine_mode, protocol: 'legacy', reason: 'rust_addon_no_protocol_export' };
    }
    // Only an EXPLICIT, self-declaring constant of the expected value is v1.
    if (c.protocolConstant === PARSE_ACCOUNTING_PROTOCOL_EXPECTED) {
        return { engine_mode, protocol: 1, reason: 'protocol_v1_capable' };
    }
    // A present-but-different constant (e.g. a future v2 or a corrupt 0) is NOT
    // silently promoted to v1. It is a non-v1 legacy-shaped surface.
    return { engine_mode, protocol: 'legacy', reason: 'rust_addon_protocol_not_v1' };
}

/**
 * Validate a single per-shard parse-accounting summary that the addon attached
 * to a fuse result. Returns a structured verdict the aggregator collects.
 *
 * A summary is "conserved + complete" ONLY when it self-declares protocolVersion
 * === 1, engine_path === 'binary' (the monitored read actually ran), its
 * declared == parsed + dropped, AND its drop-record array length === dropped
 * (drop-detail complete). A 'not_applicable' engine_path (legacy JSON shard) is
 * a valid passthrough but is NOT a monitored conserved summary.
 *
 * @param {object} acc parseAccounting object from a fuse result (camelCase).
 * @returns {{monitored:boolean, conserved:boolean, detailComplete:boolean,
 *            declared:number, parsed:number, dropped:number, records:number,
 *            reason:string}}
 */
export function validateSummary(acc) {
    if (!acc || typeof acc !== 'object') {
        return { monitored: false, conserved: false, detailComplete: false, declared: 0, parsed: 0, dropped: 0, records: 0, reason: 'no_accounting_object' };
    }
    const declared = num(acc.declaredEntityCount);
    const parsed = num(acc.parsedEntityCount);
    const dropped = num(acc.droppedEntityCount);
    const records = Array.isArray(acc.dropRecords) ? acc.dropRecords.length : -1;
    const isV1 = acc.protocolVersion === 1;
    const isBinary = acc.enginePath === 'binary';

    if (!isV1) {
        return { monitored: false, conserved: false, detailComplete: false, declared, parsed, dropped, records: Math.max(records, 0), reason: 'summary_not_protocol_v1' };
    }
    if (!isBinary) {
        // Legacy JSON shard, valid v1 passthrough but not a monitored summary.
        return { monitored: false, conserved: true, detailComplete: true, declared, parsed, dropped, records: Math.max(records, 0), reason: 'engine_path_not_applicable' };
    }
    const conserved = declared === parsed + dropped;
    const detailComplete = records === dropped; // -1 (missing array) fails this.
    let reason = 'monitored_v1';
    if (!conserved) reason = 'conservation_mismatch';
    else if (!detailComplete) reason = 'drop_detail_incomplete';
    return { monitored: true, conserved, detailComplete, declared, parsed, dropped, records: Math.max(records, 0), reason };
}

function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
