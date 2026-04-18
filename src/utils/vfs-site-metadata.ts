/**
 * V26.5 VFS Site Metadata Reader
 * Reads site_metadata table from meta-NN.db (any shard — all have same data).
 * Replaces loadCachedJSON for SSR components.
 */
import { getCachedDbConnection, loadManifest, executeSql } from '../lib/sqlite-engine.js';
import { env } from 'cloudflare:workers';

const metadataCache = new Map<string, { data: any, ts: number }>();
const CACHE_TTL = 300_000; // 5 min per isolate

export async function loadSiteMetadata(key: string): Promise<any> {
    const cached = metadataCache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

    try {
        const r2Bucket = env?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const engine = await getCachedDbConnection(r2Bucket, isDev, 'meta-00.db');
        const rows = await executeSql(engine.sqlite3, engine.db,
            'SELECT value FROM site_metadata WHERE key = ?', [key]);
        if (rows.length > 0 && rows[0].value) {
            const data = JSON.parse(rows[0].value);
            metadataCache.set(key, { data, ts: Date.now() });
            return data;
        }
    } catch (e: any) {
        console.warn(`[VFS-Meta] Failed to load ${key}:`, e.message);
    }
    return null;
}
