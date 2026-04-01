import type { APIRoute } from 'astro';
import { parseCommands, buildQuery, determineTargetDbs } from '../../utils/search-query-builder.js';
import { searchSemantic } from '../../lib/semantic-engine.js';
import { getCachedDbConnection, loadManifest, executeSql, evictCachedDb } from '../../lib/sqlite-engine.js';
import { fetchAllTermPostings, mergePostings, groupByShard } from '../../lib/term-index-engine.js';
import { env } from 'cloudflare:workers';

const CACHE_HEADERS_HIT = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400'
};
const CACHE_HEADERS_MISS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=0, s-maxage=10'
};

const DISPLAY_COLS = `e.id, e.slug, e.name, e.type, e.author, e.summary, e.fni_score, e.stars, e.downloads, e.last_modified, e.license, e.pipeline_tag, e.params_billions, e.context_length`;

function respond(results: any[], tier: string, startMs: number) {
    const headers = results.length > 0 ? CACHE_HEADERS_HIT : CACHE_HEADERS_MISS;
    return new Response(
        JSON.stringify({ results, tier, elapsed_ms: Date.now() - startMs }),
        { headers }
    );
}

/** Query a batch of shards with concurrency throttle + retry (browse mode) */
async function queryShardBatch(
    dbs: string[], sql: string, params: any[], r2Bucket: any, shouldSimulate: boolean
): Promise<any[]> {
    const CONCURRENCY_LIMIT = 4;
    let results: any[] = [];
    for (let i = 0; i < dbs.length; i += CONCURRENCY_LIMIT) {
        const chunk = dbs.slice(i, i + CONCURRENCY_LIMIT);
        const chunkResults = await Promise.all(chunk.map(async (dbName) => {
            try {
                const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
                return await executeSql(engine.sqlite3, engine.db, sql, params);
            } catch (err: any) {
                console.warn(`[SSR Search] Shard ${dbName} failed (${err.message}), retrying…`);
                try {
                    await evictCachedDb(dbName);
                    const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
                    return await executeSql(engine.sqlite3, engine.db, sql, params);
                } catch (retryErr: any) {
                    console.error(`[SSR Search] Shard ${dbName} retry failed: ${retryErr.message}`);
                    return [];
                }
            }
        }));
        results = results.concat(chunkResults.flat());
    }
    return results;
}

/**
 * Hydrate candidate UMIDs from meta shards.
 * Groups by shard, loads only needed shards (1-3 typically), queries by ID.
 */
async function hydrateCandidates(
    candidates: { umid: string; score: number; shard: number }[],
    r2Bucket: any, shouldSimulate: boolean
): Promise<any[]> {
    const shardGroups = groupByShard(candidates);
    const scoreMap = new Map(candidates.map(c => [c.umid, c.score]));
    const allRows: any[] = [];

    const hydrations = [...shardGroups.entries()].map(async ([shardIdx, umids]) => {
        const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
        const placeholders = umids.map(() => '?').join(',');
        const sql = `SELECT ${DISPLAY_COLS} FROM entities e WHERE e.id IN (${placeholders})`;
        try {
            const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
            const rows = await executeSql(engine.sqlite3, engine.db, sql, umids);
            for (const r of rows) r._score = scoreMap.get(r.id) ?? 0;
            return rows;
        } catch (err: any) {
            console.warn(`[SSR Search] Hydration shard ${dbName} failed: ${err.message}`);
            return [];
        }
    });

    const results = await Promise.all(hydrations);
    for (const rows of results) allRows.push(...rows);
    allRows.sort((a, b) => (b._score || 0) - (a._score || 0));
    for (const r of allRows) delete r._score;
    return allRows;
}

export const GET: APIRoute = async ({ url }) => {
    const start = Date.now();
    const q = url.searchParams.get('q') || '';
    const sort = url.searchParams.get('sort') || 'fni';
    const type = url.searchParams.get('type') || 'all';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '12'), 50);
    const page = Math.max(parseInt(url.searchParams.get('page') || '1'), 1);

    if (!q && type === 'all') {
        return respond([], 'empty', start);
    }

    try {
        const r2Bucket = env?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const shouldSimulate = isDev;
        const manifest = await loadManifest(r2Bucket, shouldSimulate);

        // ── S0: Edge Response Cache ──
        const manifestEtag = manifest?._etag || 'v23';
        const cacheKeyUrl = `https://search-cache.internal/${manifestEtag}/q=${encodeURIComponent(q)}&type=${type}&sort=${sort}&limit=${limit}&page=${page}`;
        const cacheKeyReq = new Request(cacheKeyUrl);
        // @ts-ignore
        const edgeCache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;

        if (edgeCache) {
            const cached = await edgeCache.match(cacheKeyReq);
            if (cached) {
                console.log(`[SSR Search] S0 cache HIT for "${q}" (${Date.now() - start}ms)`);
                return cached;
            }
        }

        let response: Response;

        if (q) {
            // ═══════════════════════════════════════════════════════════
            // V∞ Phase 1A-γ: Static Inverted Index Search
            // Step 1: Tokenize → Step 2: Parallel R2 fetch term files
            // Step 3: Merge postings → Step 4: Shard hydration
            // ═══════════════════════════════════════════════════════════
            const { terms, results: termResults, manifest: termManifest } = await fetchAllTermPostings(q, r2Bucket, isDev);

            if (termResults.size > 0) {
                let candidates = mergePostings(termResults, terms.length, 200, termManifest);

                // Type filter: apply post-merge via shard hydration filtering
                if (candidates.length > 0) {
                    const offset = (page - 1) * limit;
                    // Fetch more than needed to account for type filtering
                    const fetchCount = type !== 'all' ? Math.min(candidates.length, (offset + limit) * 3) : offset + limit;
                    const toHydrate = candidates.slice(0, fetchCount);
                    let hydrated = await hydrateCandidates(toHydrate, r2Bucket, shouldSimulate);

                    if (type !== 'all') {
                        hydrated = hydrated.filter((r: any) => r.type === type);
                    }
                    const paged = hydrated.slice(offset, offset + limit);
                    response = respond(paged, 'inverted_index', start);
                    if (edgeCache && paged.length > 0) edgeCache.put(cacheKeyReq, response.clone()).catch(() => {});
                    return response;
                }
            }

            // ── Tier 2: Semantic fallback (vector-core.bin) — 0 index results ──
            if (env?.AI) {
                const ranked = await searchSemantic(q, limit, env);
                if (ranked.length > 0) {
                    const semanticScores = new Map(ranked.map(r => [r.rowid, r.score]));
                    const placeholders = ranked.map(() => '?').join(',');
                    const sql = `SELECT *, rowid as _rowid FROM entities e WHERE e.rowid IN (${placeholders})`;
                    const dbName = 'meta-00.db'; // semantic rowids map to first shard
                    const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
                    const rows = await executeSql(engine.sqlite3, engine.db, sql, ranked.map(r => r.rowid), semanticScores);
                    rows.sort((a: any, b: any) => (b._semanticScore || 0) - (a._semanticScore || 0));
                    const unique: any[] = []; const seen = new Set<string>();
                    for (const r of rows) {
                        if (!seen.has(r.id)) { seen.add(r.id); r._source = 'fallback_only'; unique.push(r); }
                        if (unique.length >= limit) break;
                    }
                    for (const r of unique) { delete r._semanticScore; delete r._rowid; }
                    response = respond(unique, 'semantic_fallback', start);
                    if (edgeCache && unique.length > 0) edgeCache.put(cacheKeyReq, response.clone()).catch(() => {});
                    return response;
                }
            }

            return respond([], 'empty', start);
        }

        // ── Browse mode (no query) — existing meta-shard federation ──
        const parsed = parseCommands(q);
        const { sql: baseSql, params, isFTS } = buildQuery(parsed, type);
        const orderBy = sort === 'likes' ? 'e.stars DESC'
            : sort === 'last_updated' ? 'e.last_modified DESC'
            : isFTS ? 'rank' : 'e.fni_score DESC, e.raw_pop DESC, e.slug ASC';
        const offset = (page - 1) * limit;
        const finalSql = `${baseSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

        const { priority, expansion } = determineTargetDbs(type, q, page, manifest);
        let allRows = await queryShardBatch(priority, finalSql, params, r2Bucket, shouldSimulate);
        if (allRows.length < limit && expansion.length > 0) {
            const expansionRows = await queryShardBatch(expansion, finalSql, params, r2Bucket, shouldSimulate);
            allRows = allRows.concat(expansionRows);
        }

        // Dedup + sort browse results
        if (sort === 'likes') allRows.sort((a, b) => (b.likes || 0) - (a.likes || 0));
        else if (sort === 'last_updated') allRows.sort((a, b) => new Date(b.last_updated || 0).getTime() - new Date(a.last_updated || 0).getTime());
        else allRows.sort((a, b) => a._dbSort - b._dbSort);
        const unique: any[] = []; const seen = new Set<string>();
        for (const r of allRows) {
            if (!seen.has(r.id)) { seen.add(r.id); delete r._dbSort; unique.push(r); }
            if (unique.length >= limit) break;
        }

        response = respond(unique, 'browse', start);
        if (edgeCache && unique.length > 0) edgeCache.put(cacheKeyReq, response.clone()).catch(() => {});
        return response;
    } catch (e: any) {
        console.error('[SSR Search] Error:', e.message);
        return new Response(JSON.stringify({ error: e.message, tier: 'error' }), {
            status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
};
