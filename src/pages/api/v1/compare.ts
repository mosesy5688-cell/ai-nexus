/**
 * V∞ Phase 2: GET /api/v1/compare — Side-by-side model comparison.
 * Routes each ID to the correct meta-NN.db shard via xxhash64.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../lib/sqlite-engine.js';
import { xxhash64Mod } from '../../../utils/xxhash64.js';
import { META_SHARD_COUNT } from '../../../constants/shard-constants.js';
import { buildEtag, matchesIfNoneMatch, notModified } from '../../../lib/etag-helper.js';
import { deriveSlug, looksLikePaper, generatePaperCandidates } from '../../../lib/slug-helper.js';
import { scanShardsBudgeted } from '../../../lib/compare-budget.js';
import { resolveEntityMatch } from '../../../lib/entity-match-resolver.js';

const API_VERSION = 'fni_v2.0';
// V27.60: 10→25 Layer 0 surface generosity for Agent-driven bulk compare.
const MAX_IDS = 25;

const CORS_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300, s-maxage=3600',
};

const COMPARE_COLS = `id, slug, name, author, type, fni_score,
  fni_s, fni_a, fni_p, fni_r, fni_q,
  params_billions, context_length, vram_estimate_gb, license, pipeline_tag,
  downloads, stars, last_modified, architecture`;

export const GET: APIRoute = async ({ url, request }) => {
  const start = Date.now();
  const idsParam = url.searchParams.get('ids');
  if (!idsParam) return error(400, 'Missing required parameter: ids');

  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length < 2) return error(400, 'At least 2 IDs required');
  if (ids.length > MAX_IDS) return error(400, `Maximum ${MAX_IDS} IDs allowed`);

  try {
    const r2Bucket = env?.R2_ASSETS;
    const isDev = !!import.meta.env?.DEV;
    const manifest = await loadManifest(r2Bucket, isDev);
    const metaShards = Number(manifest?.partitions?.meta_shards) || META_SHARD_COUNT;

    // V27.22: ETag = manifest._etag + sorted ids — sorting normalizes order
    // so `?ids=a,b` and `?ids=b,a` share an ETag (same logical resource).
    const sortedIds = [...ids].map(s => s.toLowerCase()).sort().join(',');
    const etag = buildEtag(manifest?._etag, sortedIds);
    if (matchesIfNoneMatch(request, etag)) return notModified(etag, CORS_HEADERS);

    // Per-id candidate key set, reused for BOTH shard grouping (which shards to
    // query) and final result resolution (which keys map a row back to the id).
    const keysMap = new Map<string, string[]>();
    const shardGroups = new Map<number, Set<string>>();
    for (const id of ids) {
      const slug = deriveSlug(id);
      // V27.94 (FIX B): a bare arxiv id (2604.22294) or content-hash sha derives
      // to slug=<id>, but real papers store 'arxiv--<id>'/'unknown--<sha>' on a
      // DIFFERENT shard -> not-found. For paper-shaped ids ONLY, add the stored
      // paper forms so each lands on its own shard. Targeted (no AUTO_PREFIX
      // fan-out) to stay well under CF's ~50-subrequest limit across N ids.
      const allKeys = new Set([id.toLowerCase(), slug]);
      if (looksLikePaper(id)) {
        for (const form of generatePaperCandidates(slug)) allKeys.add(form);
      }
      keysMap.set(id, [...allKeys].filter(Boolean));
      for (const key of allKeys) {
        if (!key) continue;
        const shard = xxhash64Mod(key, metaShards);
        if (!shardGroups.has(shard)) shardGroups.set(shard, new Set());
        shardGroups.get(shard)!.add(key);
      }
    }

    // B7: budgeted, per-op-firewalled, fan-out-capped cold-shard scan. The global
    // sqlite lock serializes every op anyway, so a flat sequential loop with a
    // between-shards wall-clock budget is the only way to bail BEFORE CF's ~30s
    // ceiling. On exhaustion (budget/cap/op-timeout) we never ride to a dead
    // connection — we return an honest retryable 503 below.
    const scan = await scanShardsBudgeted(
      shardGroups,
      (dbName) => getCachedDbConnection(r2Bucket, isDev, dbName),
      (engine, keys) => {
        const placeholders = keys.map(() => '?').join(',');
        return executeSql(engine.sqlite3, engine.db,
          `SELECT ${COMPARE_COLS} FROM entities WHERE id IN (${placeholders}) OR slug IN (${placeholders})`,
          [...keys, ...keys]);
      },
      start,
    );
    const entityMap = scan.entityMap;
    const slugMap = scan.slugMap;

    const entities = ids.map(id => {
      // C4 Stage 1: gather this id's co-resident candidate rows from BOTH
      // indexes — exact-id hits (unique per id) + slug-keyed twins
      // (candidate-preserving) — then run the shared deterministic resolver.
      // For papers the matched row.slug is 'arxiv--<id>'/'unknown--<sha>', one of
      // keysMap's candidates. An EXACT typed id resolves to its own twin; a
      // bare-slug id mapping to >1 typed record is surfaced as an explicit
      // ambiguity (additive; still HTTP 200 batch envelope), never a rowid guess.
      const cand: any[] = [];
      const seen = new Set<string>();
      const push = (r: any) => { if (r && r.id && !seen.has(r.id)) { seen.add(r.id); cand.push(r); } };
      for (const key of keysMap.get(id) || []) {
        push(entityMap.get(key));
        for (const r of slugMap.get(key) || []) push(r);
      }
      const match = resolveEntityMatch(id, null, cand);
      if (match.kind === 'AMBIGUOUS') {
        // Additive ambiguity in the HTTP 200 batch. candidate_overflow (only when
        // true) marks that the co-resident set exceeded the public cap, so the
        // resolver refused a false unique from a truncated window.
        const amb: any = { id, found: false, ambiguous: true, code: 'AMBIGUOUS_ENTITY_ID', candidates: match.candidates };
        if (match.candidate_overflow) amb.candidate_overflow = true;
        return amb;
      }
      if (match.kind === 'IDENTITY_TYPE_CONFLICT') {
        // A prefix/stored-type conflict is NOT a clean miss and NOT a success:
        // surface it explicitly (found:false + code + the stored canonical
        // candidate) so the caller sees the real record and can correct the typed
        // identifier. NOT ambiguous:true — only ONE candidate is proven.
        return { id, found: false, code: 'IDENTITY_TYPE_CONFLICT', candidates: [{ id: match.row.id, type: match.row.type }] };
      }
      if (match.kind === 'NOT_FOUND') return { id, found: false };
      // FOUND -> surface the actual stored row + its true type (compare shows each
      // id's real record; the entity API is where a conflict becomes a 409).
      const e = match.row;
      return {
        id: e.id, name: e.name, author: e.author, type: e.type,
        fni_score: e.fni_score ?? 0,
        fni_factors: {
          // V27 honesty sweep: fni_s is a constant factory baseline, not a
          // per-entity measurement -> null + note (mirrors entity API + select.ts).
          semantic: null,
          semantic_note: 'query-time baseline; scored live at search; not a per-entity value',
          authority: e.fni_a ?? 0,
          popularity: e.fni_p ?? 0, recency: e.fni_r ?? 0, quality: e.fni_q ?? 0,
        },
        specs: {
          params_billions: e.params_billions, context_length: e.context_length,
          vram_estimate_gb: e.vram_estimate_gb, license: e.license,
          architecture: e.architecture, pipeline_tag: e.pipeline_tag,
        },
        popularity: { downloads: e.downloads ?? 0, stars: e.stars ?? 0 },
        last_modified: e.last_modified,
        // V27.21: type+slug routing — was hardcoded `/model/${e.id}` which sent
        // papers/tools/datasets/agents to the model detail page (404 in production).
        detail_url: `https://free2aitools.com/${e.type || 'model'}/${e.slug || e.id}`,
        badge_url: `https://free2aitools.com/api/v1/badge/${encodeURIComponent(e.slug || e.id)}`,
        found: true,
      };
    });

    // B7 honest 503: if the scan bailed (budget/cap/op-timeout) AND at least one
    // id is still unresolved, the unresolved ids MAY exist on an un-probed/errored
    // shard — exactly the entity API's transient semantics. Never report a partial
    // cold scan as a clean comparison, and never ride to a dead connection. We
    // surface which ids resolved vs pending (honest partial signal) so an Agent
    // retries only the rest. If everything resolved (warm cache) we ignore the
    // bail and return the complete 200 below.
    // A definitively-resolved id (bare ambiguity OR identity type-conflict, both
    // carrying a `code`) is NOT a transient miss — exclude it from `pending` so it
    // never forces a false 503. A clean miss {found:false} with NO code stays
    // pending: it may still be a transient/un-probed-shard miss.
    const pending = entities.filter((e: any) => !e.found && !e.ambiguous && !e.code).map((e: any) => e.id);
    if (scan.exhausted && pending.length > 0) {
      const resolved = entities.filter((e: any) => e.found).map((e: any) => e.id);
      console.error('[COMPARE] inconclusive', `reason=${scan.reason} probed=${scan.probedShards}/${shardGroups.size} resolved=${resolved.length}/${ids.length}`);
      return error(503,
        'Comparison inconclusive (transient/budget); retry later',
        { 'Retry-After': '2', 'Cache-Control': 'no-store' },
        { resolved, pending, reason: scan.reason },
      );
    }

    return new Response(JSON.stringify({
      version: API_VERSION,
      entities,
      meta: { elapsed_ms: Date.now() - start, found: entities.filter((e: any) => e.found).length, requested: ids.length },
    }), { headers: { ...CORS_HEADERS, ETag: etag } });
  } catch (e: any) {
    console.error('[COMPARE]', e.message);
    return error(500, 'Internal error');
  }
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS_HEADERS });

function error(status: number, message: string, extraHeaders: Record<string, string> = {}, extraBody: Record<string, any> = {}) {
  return new Response(JSON.stringify({ error: message, ...extraBody }), { status, headers: { ...CORS_HEADERS, ...extraHeaders } });
}
