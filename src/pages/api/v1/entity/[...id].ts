/**
 * GET /api/v1/entity/:id — Single-entity detail lookup.
 *
 * Agent-first endpoint: search returns IDs; agents fetch full structured
 * metadata for one entity here (closes the search -> detail chain, P0-3).
 * Routing: per-candidate xxhash64Mod against partitions.meta_shards, probing
 * the highest-probability shard first (see buildEntityProbePlan), then
 * SELECT * WHERE id/slug/umid IN (candidate forms), a bounded multi-row window.
 * Projection (60 raw cols -> ~30 Agent fields) lives in entity-projection.ts.
 * ?include=body lazy-loads readme_html from the .bin fused-shard (cold tier)
 * via packet-loader.fetchBundleReadme. EXCEPTION (legal-resilience L1): for
 * type=paper, ?include=body never returns the full paper body — abstract +
 * metadata + official source only (see the isPaper gate below).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../../lib/sqlite-engine.js';
import { PHASE1_READER_MODE } from '../../../../lib/published-pointer.js';
import { xxhash64Mod } from '../../../../utils/xxhash64.js';
import { META_SHARD_COUNT } from '../../../../constants/shard-constants.js';
import { buildEtag, matchesIfNoneMatch, notModified } from '../../../../lib/etag-helper.js';
import { buildEntityProbePlan } from '../../../../lib/slug-helper.js';
import { fetchBundleReadme } from '../../../../utils/packet-loader.js';
import { withOpTimeout, isOpTimeout } from '../../../../lib/op-timeout.js';
import { projectEntity } from '../../../../lib/entity-projection.js';
import { resolveShardsForCandidates } from '../../../../lib/entity-absence-oracle.js';
import { resolveEntityMatch, CANDIDATE_FETCH_LIMIT } from '../../../../lib/entity-match-resolver.js';

const API_VERSION = 'fni_v2.0';

// V27.93 (D2): wall-clock budget for the multi-shard cold-VFS probe loop.
// Mirrors the page resolver (vfs-metadata-provider FALLBACK_BUDGET_MS): an
// un-budgeted fan-out can chain many cold R2-VFS opens (19/31/88s observed)
// into CF's ~30s limit -> 524. Safe here only because buildEntityProbePlan
// orders highest-probability candidates first, so a real entity is reached
// before the budget is spent. Bailing on budget yields a retryable 503, never
// a hard 404 (honest-contract: a slow/transient miss is not "does not exist").
const PROBE_BUDGET_MS = 6000;

// Per-op timeout firewall. PROBE_BUDGET_MS above bounds the LOOP (between
// shards); this bounds a SINGLE cold op that hangs (a stalled R2 range read
// inside one connection-open or SQL step). The page resolver
// (vfs-metadata-provider OP_TIMEOUT_MS) already has this; the entity API had
// only the loop budget, so one hung op could consume the whole budget and
// surface as a 524. Must stay <= PROBE_BUDGET_MS. On timeout the op is NOT
// cancelled (op-timeout.ts header) — it finishes in the background, releases
// its own SQLite lock, and warms the cache for the retry. Matches the page path.
const OP_TIMEOUT_MS = 5000;

const CORS_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
};

export const GET: APIRoute = async ({ params, url, request }) => {
    const start = Date.now();
    const rawId = (params.id || '').trim();
    if (!rawId) return error(400, 'Missing required path parameter: id');

    const includeBody = url.searchParams.get('include')?.split(',').includes('body') || false;

    try {
        const r2Bucket = env?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const pin = await loadManifest(r2Bucket, isDev, PHASE1_READER_MODE); // R5 MF-4 fence: legacy_only == today's loadManifest
        const metaShards = Number(pin?.partitions?.meta_shards) || META_SHARD_COUNT;

        // V27.22: ETag = manifest._etag + (id, include flag) — cross-cycle
        // invalidation handled by manifest bump; ?include=body has different
        // payload so it gets a different ETag bucket.
        const etag = buildEtag(pin?._etag, rawId.toLowerCase(), includeBody ? 'body' : ''); // R5: pin._etag (NOT build_id) => byte-identical
        if (matchesIfNoneMatch(request, etag)) return notModified(etag, CORS_HEADERS);

        // V27.93 (D1+D2): ordered, paper-aware candidate plan. buildEntityProbePlan
        // injects stored paper forms (arxiv--<id> / bare / unknown--<id>) for
        // arxiv-shaped ids so ~270K papers stop 404ing, and orders the most-
        // likely-correct forms first so the budget below never starves the
        // correct shard.
        const candidates = buildEntityProbePlan(rawId);

        // Per-candidate -> its OWN shard (packer shards by xxhash64(slug); a
        // single form lands on the wrong shard). Map preserves insertion order,
        // so the highest-probability shards are probed first. We bind only the
        // forms that hashed to each shard, matching the page-resolver pattern.
        const shardForms = new Map<number, string[]>();
        for (const c of candidates) {
            const idx = xxhash64Mod(c, metaShards);
            const arr = shardForms.get(idx);
            if (arr) arr.push(c); else shardForms.set(idx, [c]);
        }

        // B4 — id-index absence oracle + index-driven candidate resolution.
        // The slim v2 index enumerates every resolvable form, so a loaded index
        // is authoritative over presence:
        //   - a candidate hits  -> probe ONLY the 1-2 resolved shards (the ~10
        //     AUTO_PREFIX cold opens that could never finish inside the budget
        //     collapse to the real shard(s); fixes the slug/bareword coin-flip).
        //   - NO candidate hits -> proven absence -> honest 404, ZERO probes
        //     (the structurally-unreachable clean-exhaustion 404 is no longer
        //     needed for index-covered ids; this is what fixes paper-page 503s).
        //   - index absent/refused -> DEGRADE to the prior fan-out EXACTLY.
        // The index never decides DATA (the real SELECT still runs on the routed
        // shard), so a hash collision only mis-routes, never falsely 404s.
        // B4 coherence gate: pass the served manifest's build_id so the oracle may
        // prove absence ONLY when it equals the index's stamped build_id (same
        // bake, same request). Incoherent -> no zero-probe 404, no destructive
        // shrink — only non-destructive reorder (full fan-out still probed).
        const resolution = await resolveShardsForCandidates(shardForms, candidates, env, pin?.build_id, pin?.logicalToBlob?.get('id-index.bin'));

        if (resolution.absenceProven) {
            // Index loaded + every candidate missed it -> genuinely absent. Same
            // honest-404 cache semantics as the clean-exhaustion 404 below.
            return error(404, `Entity not found: ${rawId}`);
        }

        // Per-shard try/catch: one shard error must not 500 the request; track errors +
        // budget-bail so a transient miss is not a false 404. C4 Stage 1 (D-331 corrected):
        // fetch CANDIDATE_FETCH_LIMIT (26 = cap+1) rows so the resolver DETECTS overflow
        // instead of truncating into a false unique (co-resident slug twins share ONE shard).
        // ORDER BY binds the requested id + umid so an EXACT-id/UMID row, if present, is ALWAYS
        // in the window regardless of twin count; type-ASC,id-ASC tiebreak keeps it deterministic.
        const exactMatchKey = rawId.toLowerCase();
        let candidateRows: any[] = [];
        let probedShards = 0;
        let budgetBailed = false;
        const shardErrors: string[] = [];
        for (const [shardIdx, forms] of resolution.orderedShards) {
            if (Date.now() - start > PROBE_BUDGET_MS) { budgetBailed = true; break; }
            probedShards++;
            const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
            const placeholders = forms.map(() => '?').join(',');
            const sql = `SELECT * FROM entities WHERE id IN (${placeholders}) OR slug IN (${placeholders}) OR umid IN (${placeholders}) ORDER BY (id = ?) DESC, (umid = ?) DESC, type ASC, id ASC LIMIT ${CANDIDATE_FETCH_LIMIT}`;
            const bindings = [...forms, ...forms, ...forms, exactMatchKey, exactMatchKey];
            try {
                // Per-op firewall: a single hung cold open/SQL must not eat the
                // whole budget or hang past it (mirrors the page resolver).
                const engine = await withOpTimeout(
                    getCachedDbConnection(r2Bucket, isDev, dbName, pin?.logicalToBlob?.get(dbName)), // R5 MF-4: undefined in legacy_only -> fixed key
                    OP_TIMEOUT_MS, `open:${dbName}`);
                const rows = await withOpTimeout(
                    executeSql(engine.sqlite3, engine.db, sql, bindings),
                    OP_TIMEOUT_MS, `sql:${dbName}`);
                if (rows.length > 0) { candidateRows = rows; break; }
            } catch (e: any) {
                console.warn(`[ENTITY] shard probe ${isOpTimeout(e) ? 'timeout' : 'error'}`, dbName, e.message);
                shardErrors.push(`${dbName}: ${e.message}`);
            }
        }

        if (candidateRows.length === 0) {
            // Honest-contract: 404 means "genuinely absent, do not retry" and is
            // only safe when every intended shard was probed cleanly with no row.
            // If we bailed on budget or any shard errored, the entity MAY exist
            // on an un-probed/errored shard -> retryable 503, never a false 404.
            if (budgetBailed || shardErrors.length > 0) {
                console.error('[ENTITY] inconclusive', rawId, `bailed=${budgetBailed} probed=${probedShards}/${resolution.orderedShards.length} idx=${resolution.indexLoaded}`, shardErrors.join('; '));
                // Honest retryable signal for Agent clients: explicit Retry-After
                // so a client retries (instead of hard-coding a fallback), and
                // no-store so this transient negative is never cached as truth.
                return error(503, 'Lookup inconclusive (transient/budget); retry later', {
                    'Retry-After': '2',
                    'Cache-Control': 'no-store',
                });
            }
            return error(404, `Entity not found: ${rawId}`);
        }

        // C4 Stage 1: deterministic, type-aware, order-independent selection. Exact
        // typed id wins; typed miss -> 404 (never the other twin); bare->>1 typed or
        // prefix/type conflict -> 409. Under overflow a bare/type fallback becomes
        // AMBIGUOUS(candidate_overflow) -> 409, NEVER a false FOUND / clean 404.
        const match = resolveEntityMatch(rawId, null, candidateRows);
        if (match.kind === 'NOT_FOUND') return error(404, `Entity not found: ${rawId}`);
        if (match.kind === 'AMBIGUOUS') {
            return ambiguity(409, 'Ambiguous entity identifier', 'AMBIGUOUS_ENTITY_ID', rawId, match.candidates, match.candidate_overflow);
        }
        if (match.kind === 'IDENTITY_TYPE_CONFLICT') {
            return ambiguity(409, 'Entity identifier type conflict', 'IDENTITY_TYPE_CONFLICT', rawId, match.candidates);
        }
        const row = match.row;

        const entity = projectEntity(row);
        // LEGAL-RESILIENCE L1 (Papers Abstract-Only, 2026-06-06): never return the
        // full third-party paper body to Agents. The abstract already ships in the
        // warm projection (entity.summary/description); ?include=body for a paper
        // returns no readme_html, only the official source. Existing papers baked
        // before the producer change still carry full text in the cold .bin, so we
        // gate at SERVE time here (effective immediately) regardless of bake state.
        const isPaper = row.type === 'paper';
        if (includeBody && isPaper) {
            entity.body = { readme_html: null, has_fulltext: false, source_url: entity.links?.source_url ?? null };
        } else if (includeBody) {
            if (row.bundle_key && row.bundle_size > 0) {
                try {
                    const bundleData = await fetchBundleReadme(row.bundle_key, row.bundle_offset, row.bundle_size);
                    entity.body = { readme_html: bundleData.readme, has_fulltext: !!row.has_fulltext };
                    // #2143: HF Space demo merged onto this model lives in the cold
                    // .bin bundle (no hot column), so it is only available here on
                    // ?include=body. Surface the full structured demo as a top-level
                    // field AND backfill links.demo_url (declared null by the warm
                    // projection) so an Agent reads the real demo URL/sdk/status.
                    // null = no demo (honest-contract, never fabricated).
                    if (bundleData.demo) {
                        const d = bundleData.demo;
                        entity.demo = {
                            demo_url: d.demo_url ?? null,
                            demo_sdk: d.demo_sdk ?? null,
                            demo_status: d.demo_status ?? null,
                        };
                        if (entity.links) entity.links.demo_url = entity.demo.demo_url;
                    }
                } catch (err: any) {
                    console.warn(`[entity] cold-tier readme fetch failed for ${row.id}:`, err?.message);
                    entity.body = { readme_html: null, has_fulltext: !!row.has_fulltext };
                }
            } else {
                entity.body = { readme_html: null, has_fulltext: !!row.has_fulltext };
            }
        }

        return new Response(JSON.stringify({
            version: API_VERSION,
            entity,
            meta: { elapsed_ms: Date.now() - start, etag: pin?._etag || null, candidates_tried: candidates.length },
        }), { headers: { ...CORS_HEADERS, ETag: etag } });
    } catch (e: any) {
        console.error('[ENTITY]', rawId, e.message, e.stack);
        return error(500, 'Internal error');
    }
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS_HEADERS });

function error(status: number, message: string, extraHeaders: Record<string, string> = {}) {
    return new Response(JSON.stringify({ error: message }), { status, headers: { ...CORS_HEADERS, ...extraHeaders } });
}

// C4 Stage 1: structured identity 409. Body carries ONLY public {id,type} candidates
// (never shard/rowid/internal); no-store so a CDN never pins an ambiguity a Stage-2
// repair would resolve. `overflow` (additive, only when true) = set exceeded the cap.
function ambiguity(status: number, message: string, code: string, requestedId: string, candidates: { id: string; type: string }[], overflow?: true) {
    const body: Record<string, any> = { error: message, code, requested_id: requestedId, candidates };
    if (overflow) body.candidate_overflow = true;
    return new Response(JSON.stringify(body), {
        status, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
    });
}
