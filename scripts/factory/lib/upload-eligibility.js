// Upload-eligibility predicate -- the SINGLE SOURCE of the R2 upload guard
// (Founder D-2026-0704-262, FIX-3 / C10 + GAP-5, option A3).
//
// This is the EXACT V27.63 r2-handoff.backupFileToR2 integrity predicate, extracted
// VERBATIM into a PURE function so that BOTH the uploader (r2-handoff.js) AND the
// prepared-entity-data authority manifest builder (shards-handoff-manifest.mjs) apply
// ONE identical rule -- a manifest can never enumerate a member the uploader would
// refuse (the GAP-5 unsatisfiable exact-set read-back), and the guard can never drift
// from the manifest. NO relaxation: the zstd magic requirement AND the 16-byte floor
// AND the non-.zst min-bytes floor are preserved bit-for-bit.
//
// PURE: no fs, no crypto, no network, no side effects. Inputs are a name (or relative
// path -- only its `.zst` suffix matters) plus the already-read data Buffer.

// Zstandard frame magic number, little-endian (bytes 28 B5 2F FD).
export const ZSTD_MAGIC_LE = 0xFD2FB528;
// A .zst payload below this many bytes is a state-wipe risk (header-only/empty frame);
// the 11-byte empty-"{}" frame that tripped GAP-5 is refused by this floor.
export const ZSTD_MIN_BYTES = 16;
// Default floor for a NON-.zst payload (matches the historical r2-handoff opts.minSize).
export const DEFAULT_MIN_BYTES = 256;

/**
 * Decide whether a file is eligible for durable R2 upload under the V27.63 guard.
 * Behavior-identical to the original inline r2-handoff predicate:
 *   .zst  -> eligible iff (zstd magic present AND data.length >= 16)
 *   other -> eligible iff (data.length >= minBytes)
 * The `reason` string is the SAME template the guard prints on a block.
 *
 * OPT-IN class-scoped required-JSON mode (opts.requiredJson) is ADDITIVE / RESCUE-ONLY (MF-1):
 * it is reached ONLY AFTER the base floor has already REFUSED a member, so it can NEVER block a
 * member the base predicate accepts. A member >= its floor (of ANY shape: .zst/.gz/.jsonl/
 * .ndjson/.json) stays eligible EXACTLY as the base guard; a sub-floor valid+non-empty non-.zst
 * non-.meta JSON (a consumer-required small transport) is RESCUED; a sub-floor .zst / .meta.json
 * sidecar / non-JSON stays blocked. This keeps generate == uploader eligibility for every shape
 * (a .gz/.jsonl authoritative member is never JSON-parsed) and is OFF by default: the default
 * path AND the 2/4 shards path stay BYTE-IDENTICAL; the .zst 16B / non-.zst 256B floors are intact.
 *
 * @param {string} nameOrRelPath - file name or relative path; its `.zst`/`.meta.json` suffix matters.
 * @param {Buffer} data - the file bytes already read by the caller.
 * @param {{ minBytes?: number, requiredJson?: boolean }} [opts] - non-.zst floor (default 256,
 *   == old opts.minSize); requiredJson opts into the ADDITIVE rescue-only required-JSON mode.
 * @returns {{ eligible: boolean, isZst: boolean, reason: (string|null) }}
 */
export function isUploadEligible(nameOrRelPath, data, opts = {}) {
    const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
    const len = data ? data.length : 0;
    const name = String(nameOrRelPath);
    const isZst = name.endsWith('.zst');
    const hasZstdMagic = isZst && len >= 4 && data.readUInt32LE(0) === ZSTD_MAGIC_LE;
    // BASE (default) eligibility -- the V27.63 guard, UNCHANGED. When requiredJson is OFF this is
    // the ONLY branch reached => the default path + the 2/4 shards path stay BYTE-IDENTICAL. A
    // member of ANY shape that clears its floor is eligible here (never JSON-parsed).
    const baseEligible = isZst ? (hasZstdMagic && len >= ZSTD_MIN_BYTES) : (len >= minBytes);
    if (baseEligible) return { eligible: true, isZst, reason: null };
    // ADDITIVE (rescue-ONLY) opt-in required-JSON transport: reached ONLY when the base floor has
    // already REFUSED the member, so it can NEVER block a member the base accepts (guard == manifest
    // by construction). Scoped to a non-.zst, non-`.meta.json` payload that is valid+non-empty JSON
    // (the consumer-required transports); a sub-floor .zst / .meta.json / non-JSON stays blocked.
    if (opts.requiredJson && !isZst && !name.endsWith('.meta.json') && isNonEmptyJson(data)) {
        return { eligible: true, isZst: false, reason: null };
    }
    const reason = isZst ? `invalid zstd (${len}B)` : `${len}B < min ${minBytes}B`;
    return { eligible: false, isZst, reason };
}

/**
 * Whole-family class-scoped required-JSON eligibility: eligible iff the bytes parse as JSON AND
 * carry content (a non-empty object/array, or a JSON primitive). An empty `{}` / `[]` / `null`,
 * or an unparseable/truncated buffer, FAILS -- a producer that emitted an empty REQUIRED JSON
 * fails LOUD rather than transporting a useless file. Pure (JSON.parse only; no fs/network).
 * @param {Buffer} data
 * @returns {boolean}
 */
export function isNonEmptyJson(data) {
    if (!data || data.length === 0) return false;
    let v;
    try { v = JSON.parse(data.toString('utf8')); } catch { return false; }
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true; // a JSON primitive (string/number/boolean) carries content
}
