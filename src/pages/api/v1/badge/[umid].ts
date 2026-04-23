/**
 * V∞ Phase 3.6: FNI Badge Service — SVG endpoint for README embedding.
 * GET /api/v1/badge/:umid → Returns color-coded SVG badge with FNI score.
 * CDN cached (1h), zero cost. Spec §6.9.
 *
 * V25.9.1 routing fix: the path segment (`:umid`) is treated as the packer's
 * routing key (slug || id) — NOT a strict UMID. Packer (`pack-db.js:165`) hashes
 * `e.slug || e.id`, so badge lookups MUST use the same key, otherwise the
 * computed shard index points at the wrong `meta-NN.db` and the row is missed
 * entirely. The path parameter name is retained for URL stability (deployed
 * README embeds); callers should pass the entity slug. The DB query matches
 * against `slug`, `id`, and `umid` columns so any of the three still resolves
 * within the routed shard. Shard count is read dynamically from the manifest
 * (`partitions.meta_shards`) via `loadManifest`, so bumping the packer's
 * META_SHARD_COUNT no longer requires touching this file.
 */
import type { APIRoute } from 'astro';
import { getCachedDbConnection, executeSql, loadManifest } from '../../../../lib/sqlite-engine.js';
import { xxhash64Mod } from '../../../../utils/xxhash64.js';
import { META_SHARD_COUNT } from '../../../../constants/shard-constants.js';
import { env } from 'cloudflare:workers';

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
    // V25.9.1: URL segment is legacy-named `:umid` but is treated as slug||id to
    // match the packer's routing key. See file header.
    const routeKey = (params.umid || '').toLowerCase();
    if (!routeKey) return svgResponse(NOT_FOUND_BADGE);

    try {
        const r2Bucket = env?.R2_ASSETS;
        const isDev = !!import.meta.env?.DEV;
        const manifest = await loadManifest(r2Bucket, isDev);
        const metaShards = Number(manifest?.partitions?.meta_shards) || META_SHARD_COUNT;
        const shardIdx = xxhash64Mod(routeKey, metaShards);
        const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
        const engine = await getCachedDbConnection(r2Bucket, isDev, dbName);
        const rows = await executeSql(engine.sqlite3, engine.db,
            'SELECT fni_score FROM entities WHERE slug = ? OR id = ? OR umid = ? LIMIT 1',
            [routeKey, routeKey, routeKey]);
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
