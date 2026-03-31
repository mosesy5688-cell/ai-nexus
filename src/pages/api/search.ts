import type { APIRoute } from 'astro';
import { parseCommands, buildQuery, determineTargetDbs } from '../../utils/search-query-builder.js';
import { searchSemantic, embedQuery, annRerankCandidates } from '../../lib/semantic-engine.js';
import { getCachedDbConnection, loadManifest, executeSql, evictCachedDb } from '../../lib/sqlite-engine.js';
// V26.0: Astro 6 migration — use cloudflare:workers instead of locals.runtime.env
import { env } from 'cloudflare:workers';

// V∞ Phase 1A: FTS5 candidate hard limit — non-negotiable (spec §5.1)
const FTS5_RERANK_LIMIT = 200;

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

/** Query a batch of shards with concurrency throttle + retry-on-failure */
async function queryShardBatch(
    dbs: string[], sql: string, params: any[],
    r2Bucket: any, shouldSimulate: boolean
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

/** Deduplicate and sort federated browse results */
function mergeBrowseResults(rows: any[], sort: string, limit: number) {
    if (sort === 'likes') {
        rows.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    } else if (sort === 'last_updated') {
        rows.sort((a, b) => new Date(b.last_updated || 0).getTime() - new Date(a.last_updated || 0).getTime());
    } else {
        rows.sort((a, b) => a._dbSort - b._dbSort);
    }
    const unique: any[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
        if (!seen.has(r.id)) { seen.add(r.id); delete r._dbSort; unique.push(r); }
        if (unique.length >= limit) break;
    }
    return unique;
}

function buildResponse(results: any[], tier: string, startMs: number, headers: Record<string, string>) {
    return new Response(JSON.stringify({ results, tier, elapsed_ms: Date.now() - startMs }), { headers });
}

/** Clean internal fields before returning to client */
function cleanRows(rows: any[]) {
    for (const r of rows) {
        delete r.search_vector; delete r._annScore; delete r._dbSort;
        delete r._semanticScore; delete r._rowid;
    }
    return rows;
}

export const GET: APIRoute = async ({ url }) => {
    const start = Date.now();
    const q = url.searchParams.get('q') || '';
    const sort = url.searchParams.get('sort') || 'fni';
    const type = url.searchParams.get('type') || 'all';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '12'), 50);
    const page = Math.max(parseInt(url.searchParams.get('page') || '1'), 1);

    if (!q && type === 'all') {
        return buildResponse([], 'empty', start, CACHE_HEADERS_MISS);
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
        // @ts-ignore - Cloudflare Workers extends CacheStorage with .default
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
            // ══════════════════════════════════════════════════════════════
            // V∞ Phase 1A: Tier 3 → Tier 2 Cascade (spec §5.1, §5.2)
            // Tier 3: FTS5 on unified search.db + ANN rerank
            // Tier 2: Semantic fallback (vector-core.bin) — ONLY if 0 FTS5 results
            // ══════════════════════════════════════════════════════════════
            const parsed = parseCommands(q);
            const fts5Query = buildFTS5Query(parsed, type);

            if (fts5Query) {
                const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, 'search.db');
                const ftsRows = await executeSql(engine.sqlite3, engine.db, fts5Query.sql, fts5Query.params);

                if (ftsRows.length > 0) {
                    // FTS5 → ANN rerank → FNI final sort → TOP K
                    let reranked = ftsRows;
                    if (env?.AI) {
                        const queryEmb = await embedQuery(q, env);
                        if (queryEmb) reranked = annRerankCandidates(ftsRows, queryEmb);
                    }
                    const offset = (page - 1) * limit;
                    const results = cleanRows(reranked.slice(offset, offset + limit));
                    response = buildResponse(results, 'fts5_ann', start, results.length > 0 ? CACHE_HEADERS_HIT : CACHE_HEADERS_MISS);
                    if (edgeCache && results.length > 0) edgeCache.put(cacheKeyReq, response.clone()).catch(() => {});
                    return response;
                    // ── HARD RETURN — Tier 3 satisfied, Tier 2 never reached ──
                }
            }

            // ── Tier 2: Semantic fallback (vector-core.bin) — last resort ──
            if (env?.AI) {
                const ranked = await searchSemantic(q, limit, env);
                if (ranked.length > 0) {
                    const semanticScores = new Map(ranked.map(r => [r.rowid, r.score]));
                    const placeholders = ranked.map(() => '?').join(',');
                    const hydrateSql = `SELECT *, rowid as _rowid FROM entities e WHERE e.rowid IN (${placeholders})`;
                    const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, 'search.db');
                    const hydrated = await executeSql(engine.sqlite3, engine.db, hydrateSql, ranked.map(r => r.rowid), semanticScores);
                    hydrated.sort((a: any, b: any) => (b._semanticScore || 0) - (a._semanticScore || 0));
                    const unique: any[] = []; const seen = new Set<string>();
                    for (const r of hydrated) {
                        if (!seen.has(r.id)) { seen.add(r.id); r._source = 'fallback_only'; unique.push(r); }
                        if (unique.length >= limit) break;
                    }
                    const results = cleanRows(unique);
                    response = buildResponse(results, 'semantic_fallback', start, results.length > 0 ? CACHE_HEADERS_HIT : CACHE_HEADERS_MISS);
                    if (edgeCache && results.length > 0) edgeCache.put(cacheKeyReq, response.clone()).catch(() => {});
                    return response;
                }
            }

            return buildResponse([], 'empty', start, CACHE_HEADERS_MISS);
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
        const results = mergeBrowseResults(allRows, sort, limit);
        const headers = results.length > 0 ? CACHE_HEADERS_HIT : CACHE_HEADERS_MISS;
        response = buildResponse(results, 'browse', start, headers);
        if (edgeCache && results.length > 0) edgeCache.put(cacheKeyReq, response.clone()).catch(() => {});
        return response;
    } catch (e: any) {
        console.error('[SSR Search] Error:', e.message);
        return new Response(JSON.stringify({ error: e.message, tier: 'error' }), {
            status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
};

/**
 * Build FTS5 SQL for search.db with search_vector included for ANN rerank.
 * Returns null if query is too short or empty.
 */
function buildFTS5Query(parsed: { query: string; filters: Record<string, string> }, type: string) {
    const q = parsed.query;
    if (!q || q.length < 2) return null;

    const safeQuery = q.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/)
        .filter((t: string) => t.length > 0).map((t: string) => `"${t}"*`).join(' AND ');
    if (!safeQuery) return null;

    const columns = `e.id, e.slug, e.name, e.type, e.author, e.summary, e.fni_score, e.stars, e.downloads, e.last_modified, e.license, e.pipeline_tag, e.params_billions, e.context_length, e.search_vector`;
    let sql = `SELECT s.rank as rank, ${columns} FROM search s JOIN entities e ON s.rowid = e.rowid WHERE search MATCH ?`;
    const params: any[] = [safeQuery];

    if (parsed.filters.author) { sql += ` AND e.author LIKE ?`; params.push(`%${parsed.filters.author}%`); }
    if (parsed.filters.license) { sql += ` AND e.license LIKE ?`; params.push(`%${parsed.filters.license}%`); }
    if (parsed.filters.task) { sql += ` AND e.pipeline_tag LIKE ?`; params.push(`%${parsed.filters.task}%`); }
    if (parsed.filters.fni) {
        const op = parsed.filters.fni.match(/[><=]+/)?.[0] || '>=';
        const val = parseFloat(parsed.filters.fni.replace(/[^\d.]/g, ''));
        if (!isNaN(val)) { sql += ` AND e.fni_score ${op} ?`; params.push(val); }
    }
    if (type && type !== 'all') { sql += ` AND e.type = ?`; params.push(type); }

    sql += ` ORDER BY rank LIMIT ${FTS5_RERANK_LIMIT}`;
    return { sql, params };
}
