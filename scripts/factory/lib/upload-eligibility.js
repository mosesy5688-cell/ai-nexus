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
 * @param {string} nameOrRelPath - file name or relative path; only its `.zst` suffix matters.
 * @param {Buffer} data - the file bytes already read by the caller.
 * @param {{ minBytes?: number }} [opts] - non-.zst floor (default 256, == old opts.minSize).
 * @returns {{ eligible: boolean, isZst: boolean, reason: (string|null) }}
 */
export function isUploadEligible(nameOrRelPath, data, opts = {}) {
    const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
    const len = data ? data.length : 0;
    const isZst = String(nameOrRelPath).endsWith('.zst');
    const hasZstdMagic = isZst && len >= 4 && data.readUInt32LE(0) === ZSTD_MAGIC_LE;
    const eligible = isZst ? (hasZstdMagic && len >= ZSTD_MIN_BYTES) : (len >= minBytes);
    const reason = eligible ? null : (isZst ? `invalid zstd (${len}B)` : `${len}B < min ${minBytes}B`);
    return { eligible, isZst, reason };
}
