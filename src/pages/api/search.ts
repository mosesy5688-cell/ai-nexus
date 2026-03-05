import type { APIRoute } from 'astro';
// @ts-ignore
import SQLiteAsyncESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs';
// @ts-ignore
import { Factory } from '@journeyapps/wa-sqlite/src/sqlite-api.js';
import { R2RangeVFS } from '../../lib/r2-vfs.js';
import { parseCommands, buildQuery, determineTargetDbs } from '../../utils/search-query-builder.js';
import { searchSemantic } from '../../lib/semantic-engine.js';

import { getCachedDbConnection, loadManifest, executeSql } from '../../lib/sqlite-engine.js';

// Mutex to serialize WASM execution
let searchMutex: Promise<void> = Promise.resolve();

export const GET: APIRoute = async ({ url, locals }) => {
    const start = Date.now();
    const q = url.searchParams.get('q') || '';
    const sort = url.searchParams.get('sort') || 'fni';
    const type = url.searchParams.get('type') || 'all';
    const mode = url.searchParams.get('mode') || 'fts5';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '12'), 50);
    const page = Math.max(parseInt(url.searchParams.get('page') || '1'), 1);

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

        let releaseLock: () => void;
        const lockAcquired = new Promise<void>(resolve => { releaseLock = resolve; });
        const previousMutex = searchMutex;
        searchMutex = previousMutex.then(() => lockAcquired).catch(() => lockAcquired);
        await previousMutex;

        try {
            const manifest = await loadManifest(r2Bucket, shouldSimulate);
            const targetDbs = determineTargetDbs(type, q, page, manifest);

            // Build Query
            let finalSql = '';
            let finalParams: any[] = [];
            let semanticScores: Map<number, number> | null = null;
            let semanticIds: number[] = [];

            if (mode === 'semantic' && env.AI) {
                const ranked = await searchSemantic(q, limit, env);
                if (ranked.length > 0) {
                    semanticScores = new Map(ranked.map(r => [r.rowid, r.score]));
                    semanticIds = ranked.map(r => r.rowid);
                    const placeholders = semanticIds.map(() => '?').join(',');
                    finalSql = `SELECT *, rowid as _rowid FROM entities e WHERE e.rowid IN (${placeholders})`;
                    finalParams = semanticIds;
                }
            }

            if (finalSql === '') {
                const { sql: baseSql, params, isFTS } = buildQuery(parsed, type);
                const orderBy = sort === 'likes' ? 'e.stars DESC'
                    : sort === 'last_updated' ? 'e.last_modified DESC'
                        : isFTS ? 'rank' : 'e.fni_score DESC';

                const offset = (page - 1) * limit;
                finalSql = `${baseSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
                finalParams = params;
            }

            // Application-Level Parallel Federated Query
            const queryPromises = targetDbs.map(async (dbName) => {
                try {
                    const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
                    return await executeSql(engine.sqlite3, engine.db, finalSql, finalParams, semanticScores || undefined);
                } catch (dbErr: any) {
                    console.warn(`[SSR Search] Query skipping empty shard ${dbName}: ${dbErr.message}`);
                    return [];
                }
            });

            const resultsArrays = await Promise.all(queryPromises);
            let allRows: any[] = resultsArrays.flat();

            // Federated Application-Level Join & Sort
            if (targetDbs.length > 1 || semanticScores) {
                if (semanticScores) {
                    allRows.sort((a, b) => b._semanticScore - a._semanticScore);
                } else if (sort === 'likes') {
                    allRows.sort((a, b) => b.likes - a.likes);
                } else if (sort === 'last_updated') {
                    allRows.sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime());
                } else {
                    // sort by _dbSort which is either FTS rank (asc) or fni (desc as neg)
                    allRows.sort((a, b) => a._dbSort - b._dbSort);
                }
            }

            // Deduplicate across DBs (e.g. core vs shard overlap if any)
            const uniqueRows = [];
            const seen = new Set();
            for (const r of allRows) {
                if (!seen.has(r.id)) {
                    seen.add(r.id);
                    delete r._semanticScore;
                    delete r._dbSort;
                    uniqueRows.push(r);
                }
            }

            const finalResults = uniqueRows.slice(0, limit);
            const elapsed = Date.now() - start;

            return new Response(JSON.stringify({ results: finalResults, tier: 'db', elapsed_ms: elapsed }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400'
                }
            });
        } finally {
            releaseLock!();
        }
    } catch (e: any) {
        console.error('[SSR Search] Error:', e.message);
        return new Response(JSON.stringify({ error: e.message, tier: 'error' }), {
            status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
};
