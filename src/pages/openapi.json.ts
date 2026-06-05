/**
 * V27.26 — Dynamic openapi.json route.
 *
 * Replaces the previously-static public/openapi.json. Schema body is held in
 * src/data/openapi-schema.json; this route mutates the /api/v1/search
 * `description` field to inject the live entity count when available. If the
 * pipeline hasn't yet written `partitions.total_entities` to the manifest,
 * the description renders catalog-only wording (no fabricated number).
 *
 * Caching follows the V27.22 pattern: ETag built from manifest._etag so the
 * description and the underlying catalog stay coherent across cycles; 304 on
 * If-None-Match hit. 5-minute CDN cache + SWR matches openapi's stability.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import schema from '../data/openapi-schema.json';
import { loadManifest } from '../lib/sqlite-engine.js';
import { getTotalEntities, formatTotalEntities } from '../utils/site-stats.js';
import { buildEtag, matchesIfNoneMatch, notModified } from '../lib/etag-helper.js';

const HEADERS: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
};

// Served types: models, tools, datasets, papers, benchmarks. agents/spaces/
// prompts dropped — agent + prompt cancelled, space merged into model
// (honest-contract: advertise only what is actually served).
const SEARCH_DESC_CATALOG = 'Full-text search across the Free2AITools catalog of AI models, tools, datasets, papers, and benchmarks, ranked by FNI score. Free tier returns up to 5 results.';

function injectCount(phrase: string | null): string {
    if (!phrase) return SEARCH_DESC_CATALOG;
    return `Full-text search across the Free2AITools catalog of ${phrase} AI models, tools, datasets, papers, and benchmarks, ranked by FNI score. Free tier returns up to 5 results.`;
}

export const GET: APIRoute = async ({ request }) => {
    const r2Bucket = (env as any)?.R2_ASSETS;
    const isDev = !!import.meta.env?.DEV;

    let manifestEtag: string | undefined;
    let total: number | null = null;
    try {
        const m = await loadManifest(r2Bucket, isDev);
        manifestEtag = m?._etag;
        total = await getTotalEntities(r2Bucket, isDev);
    } catch { /* fall through with null total + undefined etag */ }

    const phrase = formatTotalEntities(total);
    const etag = buildEtag(manifestEtag, phrase || 'no-count');
    if (matchesIfNoneMatch(request, etag)) return notModified(etag, HEADERS);

    const out = JSON.parse(JSON.stringify(schema));
    if (out?.paths?.['/api/v1/search']?.get) {
        out.paths['/api/v1/search'].get.description = injectCount(phrase);
    }

    return new Response(JSON.stringify(out, null, 2), {
        status: 200,
        headers: { ...HEADERS, ETag: etag },
    });
};
