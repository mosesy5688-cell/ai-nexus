/**
 * Cache Manager Module V16.7.2
 * Delegates to cache-core (static) and registry-io (sharded)
 */

import fs from 'fs/promises';
import path from 'path';
import { autoDecompress } from './zstd-helper.js';
import { loadWithFallback, saveWithBackup } from './cache-core.js';
export { loadWithFallback, saveWithBackup };
export {
    loadGlobalRegistry, saveGlobalRegistry,
    loadFniHistory, saveFniHistory,
    loadDailyAccum, saveDailyAccum,
    syncCacheState
} from './registry-io.js';

// Legacy compatibility for old scripts
// (Removed redundant import that caused conflict)

export async function loadEntityChecksums() {
    return loadWithFallback('entity-checksums.json.zst', {});
}

export async function saveEntityChecksums(checksums) {
    // V27.63: skip empty (header-only zstd 11B tripped r2-handoff guard; also
    // signals upstream regression since healthy cycles always have ≥1 checksum).
    if (!checksums || Object.keys(checksums).length === 0) {
        console.warn('[CACHE] entity-checksums empty — skipping save (upstream produced no entities?)');
        return;
    }
    await saveWithBackup('entity-checksums.json.zst', checksums, { compress: true });
}

// ============================================================
// D-364/D-365: entity-checksum cache restore-validation.
// A poisoned/truncated restored cache would (a) be consumed by processor-core
// as the "known-good" comparison map (silently marking every entity changed or,
// worse, undecompressable/parse-failing downstream), and (b) be re-propagated to
// the next cycle by the combined actions/cache post-save. These helpers validate
// the RESTORED artifact at the owner boundary and, on failure, invalidate the
// LOCAL cache only (never R2), turning a poisoned hit into an honest cache-miss.
// ============================================================

const ENTITY_CHECKSUMS_FILE = 'entity-checksums.json.zst';
const ZSTD_MAGIC_LE = 0xFD2FB528; // little-endian read of 28 B5 2F FD
const SHA256_HEX = /^[0-9a-f]{64}$/; // processor-core.js:87-89 digest('hex')
export const CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED = 'CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED';

// getCacheDir mirrors cache-core.js (which keeps it private). Resolve identically.
const getCacheDir = () => process.env.CACHE_DIR || './cache';
const entityChecksumsPath = () => path.join(getCacheDir(), ENTITY_CHECKSUMS_FILE);

/**
 * PURE validator (no unlink / no mutation). A restored entity-checksums artifact
 * is VALID only if EVERY condition holds; the first failure yields its reason.
 * Contract (code-grounded, processor-core.js:87-91): a valid decompressed payload
 * is a PLAIN NON-EMPTY object mapping non-empty-string entity ids to sha256 hex
 * (64 lowercase [0-9a-f]) checksums. There is no real populator (saveEntityChecksums
 * is a passthrough from merge-batches.js), so the contract comes from the consumer
 * comparison `entityChecksums[id] !== entityHash`, not from a known-good sample.
 * @param {string} filePath
 * @returns {Promise<{ valid: boolean, reason: string }>}
 */
export async function isValidEntityChecksumArtifact(filePath) {
    let st;
    try {
        st = await fs.lstat(filePath);
    } catch {
        return { valid: false, reason: 'missing' };
    }
    // Fail-closed on non-regular targets (symlink / directory / socket / fifo).
    if (st.isSymbolicLink() || !st.isFile()) return { valid: false, reason: 'not_regular_file' };
    if (st.size < 16) return { valid: false, reason: 'too_small' }; // 11B header-only fails

    let buf;
    try {
        buf = await fs.readFile(filePath);
    } catch {
        return { valid: false, reason: 'unreadable' };
    }
    if (buf.length < 16) return { valid: false, reason: 'too_small' };
    if (buf.readUInt32LE(0) !== ZSTD_MAGIC_LE) return { valid: false, reason: 'bad_magic' };

    let obj;
    try {
        const raw = await autoDecompress(buf);
        obj = JSON.parse(raw.toString('utf-8'));
    } catch {
        return { valid: false, reason: 'undecompressable' };
    }

    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        return { valid: false, reason: 'not_object' };
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) return { valid: false, reason: 'empty_set' };
    for (const k of keys) {
        if (typeof k !== 'string' || k.length === 0) return { valid: false, reason: 'invalid_entry' };
        const v = obj[k];
        if (typeof v !== 'string' || !SHA256_HEX.test(v)) return { valid: false, reason: 'invalid_entry' };
    }
    return { valid: true, reason: 'ok' };
}

/**
 * Owner-boundary reconciler. Targets ONLY entity-checksums.json.zst (never
 * task-checksums, never R2). Keep valid; LOCAL-invalidate invalid (fail-closed if
 * removal cannot be verified); no-op on absence.
 * @returns {Promise<{ status: string, reason?: string }>}
 */
export async function reconcileEntityChecksumCache() {
    const filePath = entityChecksumsPath();

    let present = true;
    try {
        await fs.lstat(filePath);
    } catch {
        present = false;
    }
    if (!present) {
        console.log(`[CHECKSUM-CACHE] No restored ${ENTITY_CHECKSUMS_FILE} — honest cache-miss (nothing to invalidate).`);
        return { status: 'absent' };
    }

    const verdict = await isValidEntityChecksumArtifact(filePath);
    if (verdict.valid) {
        console.log(`[CHECKSUM-CACHE] Restored ${ENTITY_CHECKSUMS_FILE} is VALID — kept.`);
        return { status: 'kept' };
    }

    // Non-regular targets must NOT be unlinked as if they were the artifact.
    if (verdict.reason === 'not_regular_file') {
        throw new Error(`${CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED}: refusing to invalidate non-regular file at ${filePath}`);
    }

    console.warn(`[CHECKSUM-CACHE] Restored ${ENTITY_CHECKSUMS_FILE} INVALID (${verdict.reason}) — invalidating LOCAL cache ONLY (no R2 mutation).`);
    try {
        await fs.unlink(filePath);
    } catch (e) {
        throw new Error(`${CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED}: unlink threw for ${filePath}: ${e.message}`);
    }

    let stillPresent = true;
    try {
        await fs.lstat(filePath);
    } catch {
        stillPresent = false;
    }
    if (stillPresent) {
        throw new Error(`${CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED}: ${filePath} still present after unlink`);
    }

    console.log(`[CHECKSUM-CACHE] Local invalid ${ENTITY_CHECKSUMS_FILE} removed — honest cache-miss (downstream recomputes).`);
    return { status: 'invalidated', reason: verdict.reason };
}
