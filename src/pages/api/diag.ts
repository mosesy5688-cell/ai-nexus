import type { APIRoute } from 'astro';
import { getCachedDbConnection, loadManifest, executeSql } from '../../lib/sqlite-engine';

export const prerender = false;

/**
 * V24.10 Diagnostic endpoint — traces the exact failure point in SSR data pipeline
 */
export const GET: APIRoute = async ({ locals }) => {
    const steps: { step: string, status: string, detail?: string, ms?: number }[] = [];
    const t0 = Date.now();

    try {
        const env = (locals as any).runtime?.env || {};
        const r2Bucket = env.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const shouldSimulate = !!env.SIMULATE_PRODUCTION || (isDev && env.NODE_ENV !== 'production');

        steps.push({
            step: 'env',
            status: 'ok',
            detail: JSON.stringify({
                hasR2: !!r2Bucket,
                isDev,
                shouldSimulate,
                envKeys: Object.keys(env).join(','),
                runtime: typeof (locals as any).runtime,
                hasCachesDefault: typeof caches !== 'undefined' && 'default' in caches,
                processVersionsNode: typeof process !== 'undefined' ? process.versions?.node : 'no-process',
            })
        });

        // Step 1: Load manifest
        let manifest: any;
        try {
            const t1 = Date.now();
            manifest = await loadManifest(r2Bucket, shouldSimulate);
            steps.push({
                step: 'manifest',
                status: 'ok',
                detail: JSON.stringify({ partitions: manifest?.partitions, etag: manifest?._etag }),
                ms: Date.now() - t1
            });
        } catch (e: any) {
            steps.push({ step: 'manifest', status: 'FAIL', detail: e.message });
            return respond(steps, t0);
        }

        // Step 2: Open DB connection (uses sqlite-engine singleton with pre-compiled WASM)
        const dbName = 'meta-00.db'; // V5.8: 16-way hash sharding
        let engine: any;
        try {
            const t2 = Date.now();
            engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
            steps.push({
                step: `db-open:${dbName}`,
                status: 'ok',
                detail: `sqlite3=${typeof engine.sqlite3}, db=${typeof engine.db}, db_val=${engine.db}`,
                ms: Date.now() - t2
            });
        } catch (e: any) {
            steps.push({ step: `db-open:${dbName}`, status: 'FAIL', detail: e.message, ms: Date.now() - t0 });
            return respond(steps, t0);
        }

        // Step 3: Simple count query
        try {
            const t3 = Date.now();
            const countResult = await executeSql(engine.sqlite3, engine.db,
                `SELECT count(*) as cnt FROM entities`, []);
            steps.push({
                step: 'count-entities',
                status: 'ok',
                detail: JSON.stringify(countResult),
                ms: Date.now() - t3
            });
        } catch (e: any) {
            steps.push({ step: 'count-entities', status: 'FAIL', detail: e.message });
        }

        // Step 4: Simple select query
        try {
            const t4 = Date.now();
            const rows = await executeSql(engine.sqlite3, engine.db,
                `SELECT id, name, type FROM entities LIMIT 3`, []);
            steps.push({
                step: 'select-3',
                status: 'ok',
                detail: JSON.stringify(rows),
                ms: Date.now() - t4
            });
        } catch (e: any) {
            steps.push({ step: 'select-3', status: 'FAIL', detail: e.message });
        }

        // Step 5: Check table list
        try {
            const t5 = Date.now();
            const tables = await executeSql(engine.sqlite3, engine.db,
                `SELECT name, type FROM sqlite_master WHERE type IN ('table','view')`, []);
            steps.push({
                step: 'tables',
                status: 'ok',
                detail: JSON.stringify(tables),
                ms: Date.now() - t5
            });
        } catch (e: any) {
            steps.push({ step: 'tables', status: 'FAIL', detail: e.message });
        }

        // Step 6: Try a second DB (meta-01.db) — V5.8 hash sharding
        try {
            const t6 = Date.now();
            const engine2 = await getCachedDbConnection(r2Bucket, shouldSimulate, 'meta-01.db');
            const agentCount = await executeSql(engine2.sqlite3, engine2.db,
                `SELECT count(*) as cnt FROM entities`, []);
            steps.push({
                step: 'agent-db-count',
                status: 'ok',
                detail: JSON.stringify(agentCount),
                ms: Date.now() - t6
            });
        } catch (e: any) {
            steps.push({ step: 'agent-db-count', status: 'FAIL', detail: e.message });
        }

        // Step 7: Entity type distribution in core DB (category mixing debug)
        try {
            const t7 = Date.now();
            const typeDist = await executeSql(engine.sqlite3, engine.db,
                `SELECT type, count(*) as cnt FROM entities GROUP BY type ORDER BY cnt DESC LIMIT 20`, []);
            steps.push({
                step: 'type-distribution',
                status: 'ok',
                detail: JSON.stringify(typeDist),
                ms: Date.now() - t7
            });
        } catch (e: any) {
            steps.push({ step: 'type-distribution', status: 'FAIL', detail: e.message });
        }

    } catch (e: any) {
        steps.push({ step: 'global', status: 'FATAL', detail: e.message + '\n' + e.stack });
    }

    return respond(steps, t0);
};

function respond(steps: any[], t0: number) {
    return new Response(JSON.stringify({ steps, total_ms: Date.now() - t0 }, null, 2), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
