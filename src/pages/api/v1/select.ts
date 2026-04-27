/**
 * V∞ Phase 2: POST /api/v1/select — Agent Model Selection
 * Queries rankings-model.db via R2 VFS Range Read.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../lib/sqlite-engine.js';
import { mapTaskToTag } from '../../../lib/task-mapper.js';
import { buildRationale } from '../../../lib/rationale-builder.js';

const API_VERSION = 'fni_v2.0_s50_factory';
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 5;
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=60, s-maxage=300',
};

const COMMERCIAL_LICENSES = [
  'apache-2.0', 'mit', 'bsd-3-clause', 'bsd-2-clause',
  'cc-by-4.0', 'cc0-1.0', 'unlicense', 'openrail',
];

export const POST: APIRoute = async ({ request }) => {
  const start = Date.now();
  let body: any;
  try { body = await request.json(); } catch {
    return error(400, 'Invalid JSON body');
  }

  if (!body.task) return error(400, 'Missing required field: task');
  const limit = Math.min(Math.max(body.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const explain = body.explain !== false;
  const constraints = body.constraints || {};
  const taskMap = mapTaskToTag(body.task);

  try {
    const r2Bucket = env?.R2_ASSETS;
    const isDev = !!import.meta.env?.DEV;
    const manifest = await loadManifest(r2Bucket, isDev);

    if (!manifest?.partitions?.rankings_dbs) {
      return error(503, 'Rankings data not yet available. Retry after next pipeline run.');
    }

    const dbName = 'rankings-model.db';
    const engine = await getCachedDbConnection(r2Bucket, isDev, dbName);
    const { sql, params } = buildQuery(taskMap.tag, constraints, limit);
    const rows = await executeSql(engine.sqlite3, engine.db, sql, params);

    const recommendations = rows.map((row: any, i: number) => {
      const rec: any = {
        rank: i + 1,
        model_id: row.id,
        name: row.name || row.id,
        author: row.author || '',
        fni_score: row.fni_score ?? 0,
        fni_factors: {
          semantic: row.fni_s ?? 50.0,
          authority: row.fni_a ?? 0,
          popularity: row.fni_p ?? 0,
          recency: row.fni_r ?? 0,
          quality: row.fni_q ?? 0,
        },
        params_billions: row.params_billions ?? null,
        vram_estimate_gb: row.vram_estimate_gb ?? null,
        context_length: row.context_length ?? null,
        license: row.license || null,
        pipeline_tag: row.pipeline_tag || null,
        detail_url: `https://free2aitools.com/model/${row.id}`,
        badge_url: `https://free2aitools.com/api/v1/badge/${encodeURIComponent(row.id)}`,
      };
      if (explain) {
        const r = buildRationale({ entity: row, rank: i + 1, taskTag: taskMap.tag, constraints });
        rec.confidence = r.confidence;
        rec.rationale = r.rationale;
        rec.caveats = r.caveats;
      }
      return rec;
    });

    return new Response(JSON.stringify({
      version: API_VERSION,
      task_interpreted: taskMap.tag,
      task_confidence: taskMap.confidence,
      total_candidates: recommendations.length,
      recommendations,
      meta: { elapsed_ms: Date.now() - start, db_source: dbName },
    }), { headers: CORS_HEADERS });
  } catch (e: any) {
    console.error('[SELECT]', e.message);
    return error(500, 'Internal error');
  }
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS_HEADERS });

function buildQuery(tag: string, c: any, limit: number) {
  const clauses: string[] = [];
  const params: any[] = [];

  if (tag) { clauses.push('pipeline_tag = ?'); params.push(tag); }
  if (c.max_vram_gb != null) { clauses.push('(vram_estimate_gb <= ? OR vram_estimate_gb IS NULL OR vram_estimate_gb = 0)'); params.push(c.max_vram_gb); }
  if (c.max_params_b != null) { clauses.push('(params_billions <= ? OR params_billions IS NULL OR params_billions = 0)'); params.push(c.max_params_b); }
  if (c.min_context_length != null) { clauses.push('context_length >= ?'); params.push(c.min_context_length); }
  if (c.license) {
    if (c.license === 'commercial') {
      clauses.push(`license IN (${COMMERCIAL_LICENSES.map(() => '?').join(',')})`);
      params.push(...COMMERCIAL_LICENSES);
    } else if (c.license !== 'any') {
      clauses.push('license = ?'); params.push(c.license);
    }
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);

  return {
    sql: `SELECT id, name, author, type, fni_score, pipeline_tag, license,
      vram_estimate_gb, params_billions, context_length, downloads,
      fni_s, fni_a, fni_p, fni_r, fni_q, last_modified, architecture, summary
      FROM entities ${where} ORDER BY fni_score DESC LIMIT ?`,
    params,
  };
}

function error(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}
