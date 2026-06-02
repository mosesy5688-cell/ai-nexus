/**
 * List Preload Reader (Architecture B Phase 1 - consumer fast path)
 *
 * Reads the fresh static top-N artifact emitted by the factory
 * (data/list-preload/<group>.json.zst) and returns its lean card rows.
 * This lets the SSR list pages serve from a static artifact instead of
 * opening cold wa-sqlite over R2 byte-range (the cold-empty incident).
 *
 * Returns null on any miss/parse error so the caller cleanly falls back to
 * the existing wa-sqlite rankings path (no regression, graceful no-op until
 * the producer emits the artifact on the next re-pack).
 */

import { R2_CACHE_URL } from '../config/constants.js';

/** Decode an ArrayBuffer with Zstd magic-byte detection (matches loadCachedJSON). */
async function decodeBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    // Zstd magic: 28 B5 2F FD
    if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xB5 &&
        bytes[2] === 0x2F && bytes[3] === 0xFD) {
        const { decompress } = await import('fzstd');
        return JSON.parse(new TextDecoder().decode(decompress(bytes)));
    }
    // Plain JSON (uncompressed) fallback
    return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Fetch + decode the preload artifact for a group.
 * @param {Object} r2 - R2_ASSETS binding (may be undefined)
 * @param {string} group - entity type or V6 category slug
 * @returns {Promise<{items: Array, totalEntities: number}|null>} payload, or
 *   null to trigger the wa-sqlite fallback (miss/parse error/empty).
 */
export async function readListPreload(r2, group) {
    if (!group) return null;
    const key = `data/list-preload/${group}.json.zst`;

    // Strategy 1: R2 binding (primary for SSR, no extra network hop)
    if (r2) {
        try {
            const file = await r2.get(key);
            if (file) {
                const payload = decodePayload(await file.arrayBuffer());
                if (payload) return await payload;
            }
        } catch (e) {
            console.warn(`[ListPreload] R2 read failed for ${group}: ${e.message}`);
        }
    }

    // Strategy 2: CDN fetch fallback (artifact may be edge-cached)
    try {
        const res = await fetch(`${R2_CACHE_URL}/${key}`);
        if (res.ok) {
            const payload = decodePayload(await res.arrayBuffer());
            if (payload) return await payload;
        }
    } catch (e) {
        console.warn(`[ListPreload] CDN read failed for ${group}: ${e.message}`);
    }

    return null;
}

/** Decode + validate a payload buffer; resolves to null when unusable. */
async function decodePayload(buffer) {
    const data = await decodeBuffer(buffer);
    if (!Array.isArray(data?.items) || data.items.length === 0) return null;
    return { items: data.items, totalEntities: Number(data.totalEntities) || data.items.length };
}
