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

    const entityMap = new Map<string, any>();
    await Promise.all([...shardGroups.entries()].map(async ([shardIdx, queryKeys]) => {
      const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
      const engine = await getCachedDbConnection(r2Bucket, isDev, dbName);
      const keys = [...queryKeys];
      const placeholders = keys.map(() => '?').join(',');
      const rows = await executeSql(engine.sqlite3, engine.db,
        `SELECT ${COMPARE_COLS} FROM entities WHERE id IN (${placeholders}) OR slug IN (${placeholders})`,
        [...keys, ...keys]);
      for (const row of rows) {
        entityMap.set(row.id, row);
        if (row.slug) entityMap.set(row.slug, row);
      }
    }));

    const entities = ids.map(id => {
      // Resolve via any candidate key the row was indexed under (row.id /
      // row.slug). For papers the matched row.slug is 'arxiv--<id>'/'unknown--<sha>'
      // which is one of keysMap's candidates, not the bare derived slug.
      let e = entityMap.get(id) || entityMap.get(id.toLowerCase());
      if (!e) {
        for (const key of keysMap.get(id) || []) {
          e = entityMap.get(key);
          if (e) break;
        }
      }
      if (!e) return { id, found: false };
      return {
        id: e.id, name: e.name, author: e.author, type: e.type,
        fni_score: e.fni_score ?? 0,
        fni_factors: {
          semantic: e.fni_s ?? 50.0, authority: e.fni_a ?? 0,
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

function error(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}
