/**
 * V∞ Phase 3.6: FNI Badge Service — SVG endpoint for README embedding.
 * GET /api/v1/badge/:umid → Returns color-coded SVG badge with FNI score.
 * CDN cached (1h), zero cost. Spec §6.9.
 */
import type { APIRoute } from 'astro';
import { getCachedDbConnection, executeSql } from '../../../../../lib/sqlite-engine.js';
import { xxhash64Mod } from '../../../../../utils/xxhash64.js';
import { env } from 'cloudflare:workers';

const META_SHARDS = 32;
const BADGE_CACHE = 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400';

function scoreColor(score: number): string {
    if (score >= 90) return '#4c1';      // green — excellent
    if (score >= 70) return '#08c';      // blue — good
    if (score >= 50) return '#dfb317';   // yellow — average
    return '#e05d44';                     // red — below average
}

function scoreLabel(score: number): string {
    if (score >= 90) return 'excellent';
    if (score >= 70) return 'good';
    if (score >= 50) return 'average';
    return 'below avg';
}

function renderBadge(score: number): string {
    const color = scoreColor(score);
    const label = `FNI: ${score.toFixed(1)} | ${scoreLabel(score)}`;
    const labelWidth = 50;
    const valueWidth = label.length * 6.5;
    const totalWidth = labelWidth + valueWidth;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">FNI</text>
    <text x="${labelWidth / 2}" y="14">FNI</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${score.toFixed(1)} | ${scoreLabel(score)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${score.toFixed(1)} | ${scoreLabel(score)}</text>
  </g>
</svg>`;
}

const NOT_FOUND_BADGE = `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="20" role="img">
  <clipPath id="r"><rect width="130" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)"><rect width="50" height="20" fill="#555"/><rect x="50" width="80" height="20" fill="#9f9f9f"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="25" y="14">FNI</text><text x="90" y="14">not found</text>
  </g>
</svg>`;

export const GET: APIRoute = async ({ params }) => {
    const umid = params.umid || '';
    if (!umid) return svgResponse(NOT_FOUND_BADGE);

    try {
        const r2Bucket = env?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const shardIdx = xxhash64Mod(umid, META_SHARDS);
        const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
        const engine = await getCachedDbConnection(r2Bucket, isDev, dbName);
        const rows = await executeSql(engine.sqlite3, engine.db,
            'SELECT fni_score FROM entities WHERE id = ? LIMIT 1', [umid]);
        if (rows.length > 0 && rows[0].fni_score != null) {
            return svgResponse(renderBadge(Number(rows[0].fni_score)));
        }
    } catch { /* fall through to not-found */ }

    return svgResponse(NOT_FOUND_BADGE);
};

function svgResponse(svg: string): Response {
    return new Response(svg, {
        headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': BADGE_CACHE,
            'Access-Control-Allow-Origin': '*'
        }
    });
}
