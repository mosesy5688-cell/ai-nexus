/**
 * V27.64 GET /api/v1/concepts — knowledge article list.
 *
 * Replaces the dead cache/knowledge/index.json CDN fallback. Sourced from
 * data/meta-knowledge.db articles table (V25.8 anchor DB), read via the same
 * r2-vfs.ts Range Read pipeline as entity/search APIs. Heavy content +
 * highlights_json columns are excluded from list payload; per-article detail
 * goes through /api/v1/entity/<id>.
 *
 * Pattern modeled on entity/[...id].ts: same loadManifest + ETag flow, same
 * structured error envelope, same per-shard try/catch surface (single anchor
 * DB here, but signature stays consistent for future expansion).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../lib/sqlite-engine.js';
import { buildEtag, matchesIfNoneMatch, notModified } from '../../../lib/etag-helper.js';

const API_VERSION = 'knowledge_v1';
const ANCHOR_DB = 'meta-knowledge.db';
const CATEGORY_REGEX = /^[a-z][a-z0-9-]{0,40}$/;

const CORS_HEADERS: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
};

function safeParseTags(s: any): string[] {
    if (!s) return [];
    if (typeof s !== 'string') return Array.isArray(s) ? s : [];
    try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter(t => typeof t === 'string') : []; }
    catch { return s.split(',').map(t => t.trim()).filter(Boolean); }
}

function project(r: any) {
    return {
        id: r.id,
        slug: r.slug,
        umid: r.umid || null,
        title: r.title,
        subtitle: r.subtitle || null,
        summary: r.summary || null,
        category: r.category || null,
        tags: safeParseTags(r.tags),
        author: r.author || null,
        word_count: r.word_count || 0,
        published_at: r.published_at || null,
        updated_at: r.updated_at || null,
        canonical_url: r.canonical_url || null,
    };
}

export const GET: APIRoute = async ({ url, request }) => {
    const start = Date.now();
    const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
    const offsetRaw = parseInt(url.searchParams.get('offset') || '0', 10);
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
    const category = url.searchParams.get('category');
    if (category && !CATEGORY_REGEX.test(category)) return errorResponse(400, 'BAD_REQUEST', 'Invalid category format');

    try {
        const r2Bucket = (env as any)?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const manifest = await loadManifest(r2Bucket, isDev);

        const etag = buildEtag(manifest?._etag, String(limit), String(offset), category || '');
        if (matchesIfNoneMatch(request, etag)) return notModified(etag, CORS_HEADERS);

        const engine = await getCachedDbConnection(r2Bucket, isDev, ANCHOR_DB);
        const whereSql = category ? 'WHERE status = ? AND category = ?' : 'WHERE status = ?';
        const baseParams: any[] = category ? ['published', category] : ['published'];

        const countRows = await executeSql(engine.sqlite3, engine.db, `SELECT COUNT(*) AS c FROM articles ${whereSql}`, baseParams);
        const total = countRows[0]?.c ?? 0;

        const listSql = `SELECT id, slug, umid, title, subtitle, summary, category, tags, author, word_count, published_at, updated_at, canonical_url FROM articles ${whereSql} ORDER BY published_at DESC, id ASC LIMIT ? OFFSET ?`;
        const rows = await executeSql(engine.sqlite3, engine.db, listSql, [...baseParams, limit, offset]);

        const concepts = rows.map(project);
        const nextOffset = offset + rows.length;
        const next_offset = nextOffset < total ? nextOffset : null;

        return new Response(JSON.stringify({
            version: API_VERSION,
            total_count: total,
            limit,
            offset,
            next_offset,
            category: category || null,
            concepts,
            meta: { elapsed_ms: Date.now() - start, etag: manifest?._etag || null },
        }), { headers: { ...CORS_HEADERS, ETag: etag } });
    } catch (e: any) {
        console.error('[CONCEPTS]', e?.message, e?.stack);
        return errorResponse(500, 'UPSTREAM_ERROR', 'Failed to load knowledge index');
    }
};

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: CORS_HEADERS });

function errorResponse(status: number, code: string, message: string): Response {
    return new Response(JSON.stringify({
        error: true, code, message,
        endpoint: '/api/v1/concepts',
        timestamp: Date.now(),
        _gateway_trace: 'v27.64::pr-a',
    }), { status, headers: CORS_HEADERS });
}
