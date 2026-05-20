/**
 * V27.26 Site stats helper — single source of truth for "how many entities".
 *
 * Reads `partitions.total_entities` from the shards manifest (written by
 * scripts/factory/lib/pack-finalizer.js at every 4/4 Finalize). Returns null
 * when the field is not yet present (first deploy after V27.26 ships, before
 * the next cron cycle writes the field). Callers should fall back to non-
 * numeric phrasing in that case — never fabricate a number.
 *
 * Cost: piggybacks on the existing 5-minute isolate-level manifest cache in
 * sqlite-engine.loadManifest, so the count is effectively free after first
 * call. No separate fetch.
 */
import { loadManifest } from '../lib/sqlite-engine.js';

/**
 * Returns the live global entity count, or null if not yet published.
 * @param {any} r2Bucket Cloudflare R2 binding (env.R2_ASSETS)
 * @param {boolean} isDev When true, fetches manifest from CDN instead of R2
 * @returns {Promise<number|null>}
 */
export async function getTotalEntities(r2Bucket, isDev) {
    try {
        const m = await loadManifest(r2Bucket, !!isDev);
        const n = m?.partitions?.total_entities;
        return typeof n === 'number' && n > 0 ? n : null;
    } catch {
        return null;
    }
}

/**
 * Human-friendly formatter — e.g. 514368 → "514,000+". Rounds DOWN to the
 * nearest thousand so we never overstate. Returns null untouched.
 */
export function formatTotalEntities(n) {
    if (n == null) return null;
    const floored = Math.floor(n / 1000) * 1000;
    return `${floored.toLocaleString('en-US')}+`;
}
