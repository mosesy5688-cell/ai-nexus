import { normalizeEntitySlug } from './entity-cache-reader-core.js';
import { getCachedDbConnection, loadManifest, executeSql } from '../lib/sqlite-engine.js';
import { env } from 'cloudflare:workers';

/**
 * V26.5 VFS Metadata Provider — C1 VFS-Only Detail Pages
 *
 * Resolves entity metadata directly from meta-NN.db via SQLite Range Read.
 * Replaces legacy R2 JSON path-guessing with authoritative VFS query.
 */

// V26.5: Hash routing must match pack-db deriveSlug + computeMetaShardSlot
function cyrb53(str: string, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export async function resolveVfsMetadata(type: string, slug: string, locals: any = null) {
    const isDev = !!(process.env.NODE_ENV === 'development' || import.meta.env?.DEV);
    const isSimulatingRemote = !!(typeof process !== 'undefined' && process.env.SIMULATE_PRODUCTION);
    const normalized = normalizeEntitySlug(slug, type).toLowerCase();

    // Strategy 1: Local Development (better-sqlite3)
    if (isDev && typeof window === 'undefined' && !isSimulatingRemote) {
        try {
            const { default: Database } = await import('better-sqlite3');
            const path = await import('path');
            const dbPath = path.resolve(process.cwd(), 'data/meta.db');
            const fs = await import('fs/promises');
            const exists = await fs.stat(dbPath).catch(() => null);
            if (exists) {
                const db = new Database(dbPath, { readonly: true });
                const row = db.prepare('SELECT * FROM entities WHERE slug = ? OR id = ?').get(normalized, normalized);
                db.close();
                if (row) return { data: row, source: 'local-sqlite' };
            }
        } catch (e: any) {
            console.warn('[VFS-Metadata] Local DB failed:', e.message);
        }
        return null;
    }

    // Strategy 2: Production VFS — query meta-NN.db via R2 Range Read SQLite
    if (!isDev || isSimulatingRemote) {
        const r2Bucket = env?.R2_ASSETS;
        const shouldSimulate = isDev;

        try {
            const manifest = await loadManifest(r2Bucket, shouldSimulate);
            const shardCount = manifest?.partitions?.meta_shards || 96;
            const shardIdx = cyrb53(normalized) % shardCount;
            const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;

            const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
            const rows = await executeSql(engine.sqlite3, engine.db,
                'SELECT * FROM entities WHERE slug = ? OR id = ? LIMIT 1',
                [normalized, normalized]);

            if (rows.length > 0) {
                return { data: rows[0], source: `vfs:${dbName}` };
            }

            // Fallback: try adjacent shards (hash collision or slug mismatch)
            for (let offset = 1; offset <= 2; offset++) {
                for (const delta of [offset, -offset]) {
                    const fallbackIdx = ((shardIdx + delta) % shardCount + shardCount) % shardCount;
                    const fallbackDb = `meta-${String(fallbackIdx).padStart(2, '0')}.db`;
                    try {
                        const eng = await getCachedDbConnection(r2Bucket, shouldSimulate, fallbackDb);
                        const fallbackRows = await executeSql(eng.sqlite3, eng.db,
                            'SELECT * FROM entities WHERE slug = ? OR id = ? LIMIT 1',
                            [normalized, normalized]);
                        if (fallbackRows.length > 0) {
                            return { data: fallbackRows[0], source: `vfs:${fallbackDb}(fallback)` };
                        }
                    } catch {}
                }
            }
        } catch (e: any) {
            console.warn(`[VFS-Metadata] SQLite query failed for ${normalized}:`, e.message);
        }
    }

    return null;
}
