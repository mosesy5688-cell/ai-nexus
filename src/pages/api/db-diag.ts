/**
 * V26.0: Diagnostic API for SQLite WASM Engine
 * Surfaces the exact error from WASM init / R2 VFS / DB open
 * TEMPORARY — Remove after debugging is complete
 */
import type { APIRoute } from 'astro';
// V26.0: Astro 6 migration
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, loadManifest, executeSql, evictCachedDb } from '../../lib/sqlite-engine';

export const GET: APIRoute = async ({ url }) => {
    const diag: any = { timestamp: new Date().toISOString(), steps: [] };
    const fresh = url.searchParams.get('fresh') === '1';

    try {
        // Step 1: Check R2 binding
        const r2Bucket = env?.R2_ASSETS;
        diag.r2_binding = !!r2Bucket;
        diag.steps.push({ step: 'r2_binding', ok: !!r2Bucket });

        if (!r2Bucket) {
            return new Response(JSON.stringify(diag, null, 2), {
                status: 500, headers: { 'Content-Type': 'application/json' }
            });
        }

        // Step 2: Load manifest
        const manifest = await loadManifest(r2Bucket, false);
        diag.manifest = { meta_shards: manifest?.partitions?.meta_shards, etag: manifest?._etag };
        diag.steps.push({ step: 'manifest', ok: true });

        // Step 3: Try to open meta-00.db
        const dbName = 'meta-00.db';
        if (fresh) {
            await evictCachedDb(dbName);
            diag.steps.push({ step: 'evict_cache', ok: true });
        }
        
        const engine = await getCachedDbConnection(r2Bucket, false, dbName);
        diag.steps.push({ step: 'db_open', ok: true, dbName });
        diag.db_handle = !!engine.db;
        diag.sqlite3 = !!engine.sqlite3;

        // Step 4: Try a simple query
        const rows = await executeSql(engine.sqlite3, engine.db, 'SELECT COUNT(*) as cnt FROM entities', []);
        diag.steps.push({ step: 'count_query', ok: true, result: rows });
        diag.entity_count = rows[0]?.cnt ?? 'unknown';

        // Step 5: Try a search query
        const searchRows = await executeSql(engine.sqlite3, engine.db,
            "SELECT id, name, type FROM entities LIMIT 5", []);
        diag.steps.push({ step: 'sample_query', ok: true, count: searchRows.length });
        diag.sample_entities = searchRows;

    } catch (e: any) {
        diag.error = e.message;
        diag.stack = e.stack;
        diag.steps.push({ step: 'FAILED', error: e.message });
    }

    return new Response(JSON.stringify(diag, null, 2), {
        status: diag.error ? 500 : 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
    });
};
