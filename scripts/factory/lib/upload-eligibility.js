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
 * OPT-IN class-scoped required-JSON mode (opts.requiredJson): for a member a carrier has
 * EXPLICITLY classified as a REQUIRED small JSON transport, eligibility is decided on JSON
 * VALIDITY (non-empty parseable JSON) instead of the 256B floor -- so a consumer-required 78B
 * JSON transports while a truncated/garbage/empty .json still FAILS. This is OFF by default:
 * the default path AND the 2/4 shards path stay BYTE-IDENTICAL; the mode never lowers the floor
 * for an unclassified caller. See isUploadEligibleRequiredJson for the whole-family details.
 *
 * @param {string} nameOrRelPath - file name or relative path; its `.zst`/`.meta.json` suffix matters.
 * @param {Buffer} data - the file bytes already read by the caller.
 * @param {{ minBytes?: number, requiredJson?: boolean }} [opts] - non-.zst floor (default 256,
 *   == old opts.minSize); requiredJson opts into the class-scoped required-JSON mode.
 * @returns {{ eligible: boolean, isZst: boolean, reason: (string|null) }}
 */
export function isUploadEligible(nameOrRelPath, data, opts = {}) {
    const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
    const len = data ? data.length : 0;
    const name = String(nameOrRelPath);
    const isZst = name.endsWith('.zst');
    // Class-scoped required-JSON transport (OPT-IN). Scoped to a non-.zst payload that is NOT a
    // regenerable `.meta.json` checksum sidecar (never a required transport). A .zst member is
    // unaffected (still the zstd-magic + 16B floor); an unclassified caller keeps the 256B floor.
    if (opts.requiredJson && !isZst && !name.endsWith('.meta.json')) {
        const ok = isNonEmptyJson(data);
        return { eligible: ok, isZst: false, reason: ok ? null : `invalid/empty required JSON (${len}B)` };
    }
    const hasZstdMagic = isZst && len >= 4 && data.readUInt32LE(0) === ZSTD_MAGIC_LE;
    const eligible = isZst ? (hasZstdMagic && len >= ZSTD_MIN_BYTES) : (len >= minBytes);
    const reason = eligible ? null : (isZst ? `invalid zstd (${len}B)` : `${len}B < min ${minBytes}B`);
    return { eligible, isZst, reason };
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
