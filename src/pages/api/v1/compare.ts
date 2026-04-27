/**
 * V∞ Phase 2: GET /api/v1/compare — Side-by-side model comparison.
 * Routes each ID to the correct meta-NN.db shard via xxhash64.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../lib/sqlite-engine.js';
import { xxhash64Mod } from '../../../utils/xxhash64.js';
import { META_SHARD_COUNT } from '../../../constants/shard-constants.js';

const API_VERSION = 'fni_v2.0_s50_factory';
const MAX_IDS = 10;
const SLUG_PREFIXES = [
  'hf-model', 'hf-agent', 'hf-tool', 'hf-dataset', 'hf-space', 'hf-paper', 'hf-collection',
  'gh-model', 'gh-agent', 'gh-tool', 'gh-repo',
  'arxiv-paper', 'arxiv', 'paper',
  'replicate-model', 'replicate-agent', 'replicate-space',
  'civitai-model', 'ollama-model', 'kaggle-dataset', 'kaggle-model',
  'langchain-prompt', 'langchain-agent',
  'knowledge', 'concept', 'report', 'dataset', 'model', 'agent', 'tool', 'space', 'prompt',
];

function deriveSlug(id: string): string {
  let r = (id || '').toLowerCase();
  for (const p of SLUG_PREFIXES) {
    if (r.startsWith(`${p}--`) || r.startsWith(`${p}:`) || r.startsWith(`${p}/`)) {
      r = r.slice(p.length + (r[p.length] === '-' ? 2 : 1)); break;
    }
  }
  return r.replace(/[:\/]/g, '--').replace(/^--|--$/g, '').replace(/--+/g, '--');
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300, s-maxage=3600',
};

const COMPARE_COLS = `id, name, author, type, fni_score,
  fni_s, fni_a, fni_p, fni_r, fni_q,
  params_billions, context_length, vram_estimate_gb, license, pipeline_tag,
  downloads, stars, last_modified, architecture`;

export const GET: APIRoute = async ({ url }) => {
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

    const shardGroups = new Map<number, string[]>();
    for (const id of ids) {
      const slug = deriveSlug(id);
      const shard = xxhash64Mod(slug, metaShards);
      if (!shardGroups.has(shard)) shardGroups.set(shard, []);
      shardGroups.get(shard)!.push(id);
      if (slug !== id.toLowerCase()) {
        const idShard = xxhash64Mod(id, metaShards);
        if (idShard !== shard) {
          if (!shardGroups.has(idShard)) shardGroups.set(idShard, []);
          shardGroups.get(idShard)!.push(id);
        }
      }
    }

    const entityMap = new Map<string, any>();
    for (const [shardIdx, shardIds] of shardGroups) {
      const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
      const engine = await getCachedDbConnection(r2Bucket, isDev, dbName);
      const placeholders = shardIds.map(() => '?').join(',');
      const rows = await executeSql(engine.sqlite3, engine.db,
        `SELECT ${COMPARE_COLS} FROM entities WHERE id IN (${placeholders}) OR slug IN (${placeholders})`,
        [...shardIds, ...shardIds]);
      for (const row of rows) {
        entityMap.set(row.id, row);
        if (row.slug) entityMap.set(row.slug, row);
      }
    }

    const entities = ids.map(id => {
      const e = entityMap.get(id);
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
        detail_url: `https://free2aitools.com/model/${e.id}`,
        badge_url: `https://free2aitools.com/api/v1/badge/${encodeURIComponent(e.id)}`,
        found: true,
      };
    });

    return new Response(JSON.stringify({
      version: API_VERSION,
      entities,
      meta: { elapsed_ms: Date.now() - start, found: entities.filter((e: any) => e.found).length, requested: ids.length },
    }), { headers: CORS_HEADERS });
  } catch (e: any) {
    console.error('[COMPARE]', e.message);
    return error(500, 'Internal error');
  }
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS_HEADERS });

function error(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}
