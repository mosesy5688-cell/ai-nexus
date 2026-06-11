import type { APIRoute } from 'astro';
import { parseCommands, buildQuery, determineTargetDbs } from '../../utils/search-query-builder.js';
import { getCachedDbConnection, loadManifest, executeSql, evictCachedDb } from '../../lib/sqlite-engine.js';
import { fetchAllTermPostings, mergePostings } from '../../lib/term-index-engine.js';
import { applyClusterSemanticRerank } from '../../lib/cluster-rerank.js';
import { clusterFallbackSearch } from '../../lib/cluster-fallback.js';
import {
    SearchBudget, searchTransient503, withOpTimeout,
    TERM_FETCH_TIMEOUT_MS, FALLBACK_TIMEOUT_MS,
} from '../../lib/search-budget.js';
import { queryShardBatchBudgeted, hydrateCandidatesBudgeted } from '../../lib/search-shard-ops.js';
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

// V27.44: include fni_s (Semantic factor) — was omitted pre-V27.44, hiding 35%-weight
// FNI factor from API response. Per llms.txt FNI v2.0 contract, all 5 factors should
// be exposed for ranking transparency.
const DISPLAY_COLS = `e.id, e.slug, e.name, e.type, e.author, e.summary, e.fni_score, e.fni_s, e.fni_a, e.fni_p, e.fni_r, e.fni_q, e.stars, e.downloads, e.last_modified, e.license, e.pipeline_tag, e.params_billions, e.context_length`;

function respond(results: any[], tier: string, startMs: number, totalCount?: number) {
    const headers = results.length > 0 ? CACHE_HEADERS_HIT : CACHE_HEADERS_MISS;
    return new Response(
        JSON.stringify({ results, total_count: totalCount ?? results.length, tier, elapsed_ms: Date.now() - startMs }),
        { headers }
    );
}

// B8: shard ops shared by browse + hydration. openShard retries once on a
// transient miss (evict + reopen) — the SAME warm-the-cache recovery the old
// inline path had — and runSql is a thin executeSql wrapper. Both are passed to
// the budgeted helpers so the per-op firewall wraps each call.
async function openShard(r2Bucket: any, shouldSimulate: boolean, dbName: string): Promise<any> {
    try {
        return await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
    } catch (err: any) {
        console.warn(`[SSR Search] Shard ${dbName} open failed (${err.message}), evict+retry…`);
        await evictCachedDb(dbName);
        return await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
    }
}
const runSql = (engine: any, sql: string, params: any[]) => executeSql(engine.sqlite3, engine.db, sql, params);

// P0-4: type aliases — entity rows use canonical `model`/`paper`/`tool`, but
// Agents naturally try the id-prefix form (hf-model / arxiv-paper / etc.) seen
// in search response IDs. Without these aliases ?type=hf-model returned 0/150K.
const TYPE_ALIASES: Record<string, string> = {
    'hf-model':'model','hf_model':'model','huggingface':'model','hf':'model',
    'gh-model':'model','gh_model':'model','github-model':'model','github':'model',
    'replicate-model':'model','ollama-model':'model','civitai-model':'model','kaggle-model':'model',
    'arxiv-paper':'paper','arxiv':'paper','hf-paper':'paper','semantic-scholar':'paper',
    'gh-tool':'tool','hf-tool':'tool','hf-dataset':'dataset','kaggle-dataset':'dataset',
};
const normalizeType = (t: string) => TYPE_ALIASES[t.toLowerCase()] || t.toLowerCase();

export const GET: APIRoute = async ({ url }) => {
    const start = Date.now();
    const budget = new SearchBudget(start);
    const q = url.searchParams.get('q') || '';
    const sort = url.searchParams.get('sort') || 'fni';
    const type = normalizeType(url.searchParams.get('type') || 'all');
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
        const open = (dbName: string) => openShard(r2Bucket, shouldSimulate, dbName);

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
            // V∞ Phase 1A-γ: Static Inverted Index Search (B8-budgeted)
            // ═══════════════════════════════════════════════════════════
            // B8: term-index R2 fetches under a per-op firewall (capped by the
            // remaining route budget). If the budget is already spent here, 503.
            const { terms, results: termResults, manifest: termManifest } = await fetchAllTermPostings(
                q, r2Bucket, isDev, budget.opBudget(TERM_FETCH_TIMEOUT_MS),
            );
            if (budget.over() && termResults.size === 0) {
                return searchTransient503('term_index_timeout', 'inverted_index');
            }

            if (termResults.size > 0) {
                let candidates = mergePostings(termResults, terms.length, 200, termManifest);

                if (candidates.length > 0) {
                    const offset = (page - 1) * limit;
                    const fetchCount = type !== 'all' ? candidates.length : offset + limit;
                    const toHydrate = candidates.slice(0, fetchCount);
                    // B8: cold-shard hydration under the route budget + per-op firewall.
                    const hyd = await hydrateCandidatesBudgeted(
                        toHydrate, r2Bucket, shouldSimulate, budget, DISPLAY_COLS, open, runSql,
                    );
                    let hydrated = hyd.rows;
                    // Transient distinct from empty: only 503 if the cold scan bailed
                    // AND it yielded nothing usable. A partial-but-nonempty result is
                    // returned (cacheable miss headers), never a fake-complete claim.
                    if (hyd.exhausted && hydrated.length === 0) {
                        return searchTransient503('cold_shard_timeout', 'inverted_index');
                    }

                    await applyClusterSemanticRerank(hydrated, q, env, r2Bucket, isDev);

                    if (type !== 'all') hydrated = hydrated.filter((r: any) => r.type === type);
                    const paged = hydrated.slice(offset, offset + limit);
                    response = respond(paged, 'inverted_index', start, hydrated.length);
                    if (edgeCache && paged.length > 0) edgeCache.put(cacheKeyReq, response.clone()).catch(() => {});
                    return response;
                }
            }

            // ── Tier 2: Cluster semantic fallback — 0 inverted index results ──
            // B8 (the most dangerous class): zero-inverted-hit queries used to enter
            // an UNBOUNDED embed + 2 full-bin GETs. Now the whole fallback runs under
            // a hard timeout = min(FALLBACK_TIMEOUT_MS, remaining route budget); if
            // the budget is spent OR the fallback cannot finish, we return an honest
            // signal (503), NEVER a dead connection and NEVER a fake-empty result.
            if (env?.AI && !budget.over()) {
                const fbCap = budget.opBudget(FALLBACK_TIMEOUT_MS);
                try {
                    const fallbackCandidates = await withOpTimeout(
                        clusterFallbackSearch(q, limit, r2Bucket, isDev, manifest, env, { opTimeoutMs: fbCap }),
                        fbCap, 'cluster_fallback',
                    );
                    if (fallbackCandidates && fallbackCandidates.length > 0) {
                        const hyd = await hydrateCandidatesBudgeted(
                            fallbackCandidates.map(c => ({ umid: c.id, score: c.score, shard: c.shard })),
                            r2Bucket, shouldSimulate, budget, DISPLAY_COLS, open, runSql,
                        );
                        const hydrated = hyd.rows;
                        if (hyd.exhausted && hydrated.length === 0) {
                            return searchTransient503('cold_shard_timeout', 'cluster_fallback');
                        }
                        for (const r of hydrated) r._source = 'cluster_fallback';
                        const unique: any[] = []; const seen = new Set<string>();
                        for (const r of hydrated) { if (!seen.has(r.id)) { seen.add(r.id); unique.push(r); } if (unique.length >= limit) break; }
                        response = respond(unique, 'cluster_fallback', start);
                        if (edgeCache && unique.length > 0) edgeCache.put(cacheKeyReq, response.clone()).catch(() => {});
                        return response;
                    }
                } catch (e: any) {
                    // A timed-out fallback is a TRANSIENT, not an empty result.
                    // Surface it honestly so the caller/agent retries rather than
                    // concluding the query has no matches (a transient must never
                    // masquerade as an empty result). Distinguish the embed timeout
                    // (the AI-binding call) from the broader fallback budget so
                    // telemetry/agents see which op stalled.
                    console.warn(`[SSR Search] Cluster fallback bailed: ${e?.message}`);
                    const embedStalled = e?.code === 'VFS_OP_TIMEOUT' && /fallback:embed/.test(e?.message || '');
                    return searchTransient503(
                        embedStalled ? 'embedding_timeout' : 'cluster_fallback_budget',
                        'cluster_fallback',
                    );
                }
            } else if (env?.AI && budget.over()) {
                // Budget spent before fallback could even start -> transient, not empty.
                return searchTransient503('search_budget_exceeded', 'cluster_fallback');
            }

            // Genuine empty: inverted index + (when applicable) a COMPLETED fallback
            // both produced nothing. This is a real "no results", not a transient.
            return respond([], 'empty', start);
        }

        // ── Browse mode (no query) — budgeted meta-shard federation ──
        const parsed = parseCommands(q);
        const { sql: baseSql, params } = buildQuery(parsed, type);
        const orderBy = sort === 'likes' ? 'e.stars DESC'
            : sort === 'last_updated' ? 'e.last_modified DESC'
            : 'e.fni_score DESC, e.raw_pop DESC, e.slug ASC';
        const offset = (page - 1) * limit;
        const finalSql = `${baseSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

        const { priority, expansion } = determineTargetDbs(type, q, page, manifest);
        const prio = await queryShardBatchBudgeted(priority, finalSql, params, r2Bucket, shouldSimulate, budget, open, runSql);
        let allRows = prio.rows;
        let exhausted = prio.exhausted;
        if (allRows.length < limit && expansion.length > 0 && !budget.over()) {
            const exp = await queryShardBatchBudgeted(expansion, finalSql, params, r2Bucket, shouldSimulate, budget, open, runSql);
            allRows = allRows.concat(exp.rows);
            exhausted = exhausted || exp.exhausted;
        }
        // Transient distinct from empty: a budget-bailed browse with NO rows is a
        // retryable 503, not an authoritative empty page.
        if (exhausted && allRows.length === 0) {
            return searchTransient503('cold_shard_timeout', 'browse');
        }

        if (sort === 'likes') allRows.sort((a, b) => (b.stars || 0) - (a.stars || 0));
        else if (sort === 'last_updated') allRows.sort((a, b) => new Date(b.last_modified || 0).getTime() - new Date(a.last_modified || 0).getTime());
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
        console.error('[SSR Search] Error:', e.message, e.stack);
        return new Response(JSON.stringify({ error: 'Internal search error', tier: 'error' }), {
            status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
};
