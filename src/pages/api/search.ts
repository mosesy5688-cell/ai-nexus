import type { APIRoute } from 'astro';
// @ts-ignore
import SQLiteAsyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
// @ts-ignore
import { Factory } from '@journeyapps/wa-sqlite/src/sqlite-api.js';
import { R2RangeVFS } from '../../lib/r2-vfs.js';
import { parseCommands, buildQuery } from '../../utils/search-query-builder.js';
import { searchSemantic } from '../../lib/semantic-engine.js';
// @ts-ignore
import wasmUrl from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.wasm?url';

export const GET: APIRoute = async ({ url, locals }) => {
    const start = Date.now();
    const q = url.searchParams.get('q') || '';
    const sort = url.searchParams.get('sort') || 'fni';
    const type = url.searchParams.get('type') || 'all';
    const mode = url.searchParams.get('mode') || 'fts5';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '12'), 50);
    const page = Math.max(parseInt(url.searchParams.get('page') || '1'), 1);

    // Empty search case: skip DB connection entirely
    if (!q && type === 'all') {
        return new Response(JSON.stringify({ results: [], tier: 'empty', elapsed_ms: 0 }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400'
            }
        });
    }

    try {
        const parsed = parseCommands(q);
        const env = (locals as any).runtime?.env || {};
        const r2Bucket = env?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const shouldSimulate = !!env?.SIMULATE_PRODUCTION || (isDev && env?.NODE_ENV !== 'production');

        // 1. Initialize wa-sqlite WASM Engine
        let wasmConfig: any = {};
        if (typeof process !== 'undefined' && process.versions?.node) {
            const { readFileSync } = await import('fs');
            const { resolve, dirname } = await import('path');
            const { fileURLToPath } = await import('url');
            const wasmPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/@journeyapps/wa-sqlite/dist/wa-sqlite-async.wasm');
            try {
                wasmConfig.wasmBinary = readFileSync(wasmPath);
            } catch (e) {
                console.warn('WASM local read failed, falling back to default locateFile');
            }
        }

        const module = await SQLiteAsyncESMFactory(wasmConfig);
        const sqlite3 = Factory(module);

        // 2. Register ETag-Isolated VFS
        // Unique VFS name handles concurrent SSR requests / HMR perfectly
        const vfsName = `r2-range-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const vfs = new R2RangeVFS(r2Bucket, { simulate: shouldSimulate }, module);
        // @ts-ignore - set name explicitly for wa-sqlite internal binding
        vfs.name = vfsName;
        sqlite3.vfs_register(vfs, true);

        // 3. Open DB (FacadeVFS ensures no 'unable to open/readonly' errors)
        const db = await sqlite3.open_v2('meta.db', 1, vfsName);

        // 4. Build & Exec Query (FTS5 / B-Tree Cascade vs Semantic Engine)
        let finalSql = '';
        let finalParams = [];
        let semanticScores: Map<number, number> | null = null;
        let semanticIds: number[] = [];

        if (mode === 'semantic' && env.AI) {
            const ranked = await searchSemantic(q, limit, env);
            if (ranked.length > 0) {
                semanticScores = new Map(ranked.map(r => [r.rowid, r.score]));
                semanticIds = ranked.map(r => r.rowid);
                // Override query to fetch by explicit ROWID
                const placeholders = semanticIds.map(() => '?').join(',');
                finalSql = `SELECT *, rowid as _rowid FROM entities e WHERE e.rowid IN (${placeholders})`;
                finalParams = semanticIds;
            }
        }

        // Fallback or Normal Keyword Search
        if (finalSql === '') {
            const { sql: baseSql, params, isFTS } = buildQuery(parsed, type);
            const orderBy = sort === 'likes' ? 'e.stars DESC'
                : sort === 'last_updated' ? 'e.last_modified DESC'
                    : isFTS ? 'rank' : 'e.fni_score DESC';

            const offset = (page - 1) * limit;
            finalSql = `${baseSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
            finalParams = params;
        }

        const rows: any[] = [];

        // Use generator iteration to stream through FTS5 results
        for await (const stmt of sqlite3.statements(db, finalSql)) {
            if (finalParams.length > 0) sqlite3.bind_collection(stmt, finalParams);
            let columns: string[] | null = null;

            while (await sqlite3.step(stmt) === 100) {  // 100 = SQLITE_ROW
                columns = columns ?? sqlite3.column_names(stmt);
                const row = sqlite3.row(stmt);
                const obj: any = {};
                columns!.forEach((c, idx) => obj[c] = row[idx]);

                // Apply dynamic FNI and context attributes
                rows.push({
                    id: obj.id, name: obj.name, slug: obj.slug, type: obj.type,
                    author: obj.author, description: obj.summary, fni_score: obj.fni_score,
                    likes: obj.stars, downloads: obj.downloads, last_updated: obj.last_modified,
                    license: obj.license, task: obj.pipeline_tag,
                    params_billions: obj.params_billions, context_length: obj.context_length,
                    // If semantic search, attach the score and rowid for sorting
                    _semanticScore: semanticScores ? semanticScores.get(obj._rowid) || 0 : 0
                });
            }
        }

        // If semantic mode, sort the final rows by semantic score
        if (semanticScores) {
            rows.sort((a, b) => b._semanticScore - a._semanticScore);
            // Optional: remove internal fields before sending to client
            rows.forEach(r => delete r._semanticScore);
        }

        await sqlite3.close(db);
        const elapsed = Date.now() - start;

        // 5. Output with 30-min Browser / 1-hour Edge SWR Cache
        return new Response(JSON.stringify({ results: rows, tier: 'db', elapsed_ms: elapsed }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400'
            }
        });

    } catch (e: any) {
        console.error('[SSR Search] Error:', e.message);
        return new Response(JSON.stringify({ error: e.message, tier: 'error' }), {
            status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
};
