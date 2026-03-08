import type { APIRoute } from 'astro';
import { parseCommands, buildQuery, determineTargetDbs } from '../../utils/search-query-builder.js';
import { searchSemantic } from '../../lib/semantic-engine.js';
import { getCachedDbConnection, loadManifest, executeSql } from '../../lib/sqlite-engine.js';

// Mutex to serialize WASM execution within a single Isolate (prevents OOM)
let searchMutex: Promise<void> = Promise.resolve();

const RESPONSE_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400'
};

/** Query a batch of shards with concurrency throttle (Anti-OOM) */
async function queryShardBatch(
    dbs: string[], sql: string, params: any[],
    r2Bucket: any, shouldSimulate: boolean, semanticScores?: Map<number, number>
): Promise<any[]> {
    const CONCURRENCY_LIMIT = 4;
    let results: any[] = [];
    for (let i = 0; i < dbs.length; i += CONCURRENCY_LIMIT) {
        const chunk = dbs.slice(i, i + CONCURRENCY_LIMIT);
        const chunkResults = await Promise.all(chunk.map(async (dbName) => {
            try {
                const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
                return await executeSql(engine.sqlite3, engine.db, sql, params, semanticScores);
            } catch (err: any) {
                console.warn(`[SSR Search] Skipping shard ${dbName}: ${err.message}`);
                return [];
            }
        }));
        results = results.concat(chunkResults.flat());
    }
    return results;
}

/** Deduplicate and sort federated results */
function mergeResults(rows: any[], sort: string, limit: number, semanticScores?: Map<number, number> | null) {
    if (semanticScores) {
        rows.sort((a, b) => b._semanticScore - a._semanticScore);
    } else if (sort === 'likes') {
        rows.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    } else if (sort === 'last_updated') {
        rows.sort((a, b) => new Date(b.last_updated || 0).getTime() - new Date(a.last_updated || 0).getTime());
    } else {
        rows.sort((a, b) => a._dbSort - b._dbSort);
    }

    const unique: any[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            delete r._semanticScore;
            delete r._dbSort;
            unique.push(r);
        }
        if (unique.length >= limit) break;
    }
    return unique;
}

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
            headers: RESPONSE_HEADERS
        });
    }

    try {
        const env = (locals as any).runtime?.env || {};
        const r2Bucket = env?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const shouldSimulate = !!env?.SIMULATE_PRODUCTION || (isDev && env?.NODE_ENV !== 'production');
        const manifest = await loadManifest(r2Bucket, shouldSimulate);

        // ── S0: Edge Response Cache (caches.default) ──
        // Check BEFORE acquiring searchMutex so cached hits never block other requests
        const manifestEtag = manifest?._etag || 'v23';
        const cacheKeyUrl = `https://search-cache.internal/${manifestEtag}/q=${encodeURIComponent(q)}&type=${type}&sort=${sort}&mode=${mode}&limit=${limit}&page=${page}`;
        const cacheKeyReq = new Request(cacheKeyUrl);
        // @ts-ignore - Cloudflare Workers extends CacheStorage with .default
        const edgeCache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;

        if (edgeCache) {
            const cached = await edgeCache.match(cacheKeyReq);
            if (cached) {
                console.log(`[SSR Search] S0 cache HIT for "${q}" (${Date.now() - start}ms)`);
                return cached;
            }
        }

        // ── S0 Miss: Acquire mutex and execute federated query ──
        const parsed = parseCommands(q);

        let releaseLock: () => void;
        const lockAcquired = new Promise<void>(resolve => { releaseLock = resolve; });
        const previousMutex = searchMutex;
        searchMutex = previousMutex.then(() => lockAcquired).catch(() => lockAcquired);
        await previousMutex;

        try {
            // Build SQL
            let finalSql = '';
            let finalParams: any[] = [];
            let semanticScores: Map<number, number> | null = null;

            if (mode === 'semantic' && env.AI) {
                const ranked = await searchSemantic(q, limit, env);
                if (ranked.length > 0) {
                    semanticScores = new Map(ranked.map(r => [r.rowid, r.score]));
                    const placeholders = ranked.map(() => '?').join(',');
                    finalSql = `SELECT *, rowid as _rowid FROM entities e WHERE e.rowid IN (${placeholders})`;
                    finalParams = ranked.map(r => r.rowid);
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

            // ── Two-Phase Federated Query ──
            const { priority, expansion } = determineTargetDbs(type, q, page, manifest);

            // Phase A: Priority shards (core + single-shard categories)
            let allRows = await queryShardBatch(
                priority, finalSql, finalParams, r2Bucket, shouldSimulate, semanticScores || undefined
            );

            // Phase B: Expansion shards (only if Phase A results insufficient)
            if (allRows.length < limit && expansion.length > 0) {
                const expansionRows = await queryShardBatch(
                    expansion, finalSql, finalParams, r2Bucket, shouldSimulate, semanticScores || undefined
                );
                allRows = allRows.concat(expansionRows);
            }

            const finalResults = mergeResults(allRows, sort, limit, semanticScores);
            const elapsed = Date.now() - start;
            const tier = semanticScores ? 'semantic' : 'db';

            const response = new Response(
                JSON.stringify({ results: finalResults, tier, elapsed_ms: elapsed }),
                { headers: RESPONSE_HEADERS }
            );

            // ── Write back to S0 edge cache (non-blocking) ──
            if (edgeCache && finalResults.length > 0) {
                edgeCache.put(cacheKeyReq, response.clone()).catch(() => {});
            }

            return response;
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
