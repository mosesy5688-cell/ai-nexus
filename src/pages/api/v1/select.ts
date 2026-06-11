/**
 * V∞ Phase 2: POST /api/v1/select — Agent Model Selection
 * Queries rankings-model.db via R2 VFS Range Read.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../lib/sqlite-engine.js';
import { mapTaskToTag, getCategoryForInput } from '../../../lib/task-mapper.js';
import { buildRationale } from '../../../lib/rationale-builder.js';
// C4 (Commercialization-Constitution): the un-buyable ranking comparator. The
// SQL below orders by the same public keys; we re-assert that order in JS via
// the SHARED comparator so the order derives ONLY from public FNI structure
// (params-presence + fni_score), never a paid signal. See ranking-order.ts.
import { orderCandidates } from '../../../lib/ranking-order.js';

const API_VERSION = 'fni_v2.0';
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 5;
const CORS_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=60, s-maxage=300',
};

// V27.81: aligned to LICENSE_MAP output casing (base-adapter.js:64-91).
// SQL uses LOWER() on both sides so this list is defense-in-depth.
const COMMERCIAL_LICENSES = [
  'Apache-2.0', 'MIT', 'BSD-3-Clause', 'BSD-2-Clause',
  'CC-BY-4.0', 'CC0-1.0', 'Unlicense', 'OpenRAIL',
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
  const taskCategory = getCategoryForInput(body.task);

  try {
    const r2Bucket = env?.R2_ASSETS;
    const isDev = !!import.meta.env?.DEV;
    const manifest = await loadManifest(r2Bucket, isDev);

    if (!manifest?.partitions?.rankings_dbs) {
      return error(503, 'Rankings data not yet available. Retry after next pipeline run.');
    }

    const dbName = 'rankings-model.db';
    const engine = await getCachedDbConnection(r2Bucket, isDev, dbName);
    const { sql, params } = buildQuery(taskMap.tag, constraints, limit, taskCategory);
    const dbRows = await executeSql(engine.sqlite3, engine.db, sql, params);
    // C4 anti-arbitration: re-order with the shared public-only comparator. The
    // SQL already returns this order; this re-assert makes the un-buyable ranking
    // comparator part of the live serve path (the C4 canary tests the same fn).
    const rows = orderCandidates(dbRows as any[]);

    const entries = rows.map((row: any, i: number) => {
      const rec: any = {
        rank: i + 1,
        model_id: row.id,
        name: row.name || row.id,
        author: row.author || '',
        fni_score: row.fni_score ?? 0,
        fni_factors: {
          // V27 honesty sweep: fni_s is a constant factory baseline, not a
          // per-entity measurement (real S is scored live at query time by the
          // cluster-ANN). Emit null + note so Agents do not read a bare 50.0 as
          // "moderately relevant" (honest-contract; mirrors entity API [...id].ts).
          semantic: null,
          semantic_note: 'query-time baseline; scored live at search; not a per-entity value',
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
        ollama_compatible: !!row.ollama_compatible,
        hosted_on: parseHostedOn(row.hosted_on),
        license_type: row.license_type || 'unknown',
        can_run_local: !!row.can_run_local,
        // V27.21: type+slug routing — was hardcoded `/model/${row.id}` + badge by id.
        // Same fix as compare.ts; entity.ts:135 already uses this pattern.
        detail_url: `https://free2aitools.com/${row.type || 'model'}/${row.slug || row.id}`,
        badge_url: `https://free2aitools.com/api/v1/badge/${encodeURIComponent(row.slug || row.id)}`,
      };
      if (explain) {
        const r = buildRationale({ entity: row, constraints });
        // Identity-layer contract: emit a factual FNI factor/spec summary, not a
        // selection verdict. No pseudo-confidence — signal strength lives in the
        // FNI fields/badge. The honest caveats (Ollama/GGUF, VRAM, license) stay.
        rec.fni_summary = r.fni_summary;
        rec.caveats = r.caveats;
      }
      return rec;
    });

    return new Response(JSON.stringify({
      version: API_VERSION,
      task_interpreted: taskMap.tag,
      total_candidates: entries.length,
      entries,
      meta: { elapsed_ms: Date.now() - start },
    }), { headers: CORS_HEADERS });
  } catch (e: any) {
    // V27.44: surface diagnostics. Pre-V27.44 'Internal error' masked everything —
    // 500s in production were undiagnosable without wrangler tail.
    const errMsg = e?.message || String(e);
    const errStack = e?.stack || '(no stack)';
    console.error('[SELECT] error:', errMsg);
    console.error('[SELECT] stack:', errStack);
    console.error('[SELECT] task:', body?.task, 'taskCategory:', taskCategory, 'constraints:', JSON.stringify(constraints || {}));
    return new Response(
      JSON.stringify({ error: 'Internal error', detail: errMsg, hint: 'check task field + constraints; see CF Worker logs for stack' }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS_HEADERS });

function buildQuery(tag: string, c: any, limit: number, category: string | null = null) {
  const clauses: string[] = [];
  const params: any[] = [];

  if (tag) { clauses.push('pipeline_tag = ?'); params.push(tag); }
  if (category && category !== 'chat') {
    clauses.push('task_categories LIKE ?'); params.push(`%${category}%`);
  }
  if (c.max_vram_gb != null) { clauses.push('(vram_estimate_gb <= ? OR vram_estimate_gb IS NULL OR vram_estimate_gb = 0)'); params.push(c.max_vram_gb); }
  if (c.max_params_b != null) { clauses.push('(params_billions <= ? OR params_billions IS NULL OR params_billions = 0)'); params.push(c.max_params_b); }
  if (c.min_context_length != null) { clauses.push('context_length >= ?'); params.push(c.min_context_length); }
  if (c.license) {
    if (c.license === 'commercial') {
      clauses.push(`LOWER(license) IN (${COMMERCIAL_LICENSES.map(() => 'LOWER(?)').join(',')})`);
      params.push(...COMMERCIAL_LICENSES);
    } else if (c.license !== 'any') {
      clauses.push('LOWER(license) = LOWER(?)'); params.push(c.license);
    }
  }
  if (c.ollama_compatible) { clauses.push('ollama_compatible = 1'); }
  if (c.can_run_local) { clauses.push('can_run_local = 1'); }
  if (c.hosted_on) { clauses.push("hosted_on LIKE '%' || ? || '%'"); params.push(c.hosted_on); }
  if (c.license_type && c.license_type !== 'any') { clauses.push('license_type = ?'); params.push(c.license_type); }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);

  return {
    sql: `SELECT id, slug, name, author, type, fni_score, pipeline_tag, license,
      vram_estimate_gb, params_billions, context_length, downloads,
      fni_s, fni_a, fni_p, fni_r, fni_q, last_modified, architecture, summary,
      ollama_compatible, hosted_on, license_type, can_run_local
      FROM entities ${where}
      ORDER BY (CASE WHEN params_billions > 0 THEN 0 ELSE 1 END), fni_score DESC LIMIT ?`,
    params,
  };
}

function parseHostedOn(raw: any): string[] {
  if (!raw || raw === '[]') return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function error(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}
