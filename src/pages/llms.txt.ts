/**
 * V27.26 — Dynamic llms.txt route.
 *
 * Replaces the previously-static public/llms.txt. Template body lives in
 * src/data/llms-template.txt with `{{TOTAL_ENTITIES_PHRASE}}` placeholders
 * that this route replaces with " N+" (leading space, formatted count) when
 * the manifest has a live count, or "" when not yet published.
 *
 * Caching: V27.22 ETag pattern, 5-min CDN cache + SWR.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import template from '../data/llms-template.txt?raw';
import { loadManifest } from '../lib/sqlite-engine.js';
import { getTotalEntities, formatTotalEntities } from '../utils/site-stats.js';
import { buildEtag, matchesIfNoneMatch, notModified } from '../lib/etag-helper.js';

const HEADERS: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
};

export const GET: APIRoute = async ({ request }) => {
    const r2Bucket = (env as any)?.R2_ASSETS;
    const isDev = !!import.meta.env?.DEV;

    let manifestEtag: string | undefined;
    let total: number | null = null;
    try {
        const m = await loadManifest(r2Bucket, isDev);
        manifestEtag = m?._etag;
        total = await getTotalEntities(r2Bucket, isDev);
    } catch { /* null total + undefined etag */ }

    const phrase = formatTotalEntities(total);
    const etag = buildEtag(manifestEtag, phrase || 'no-count');
    if (matchesIfNoneMatch(request, etag)) return notModified(etag, HEADERS);

    // `{{TOTAL_ENTITIES_PHRASE}}` → " N+" when available, "" otherwise.
    // Leading space included so phrasing reads naturally ("index of N+ AI..." vs "index of AI...").
    const replacement = phrase ? ` ${phrase}` : '';
    const body = template.replace(/\{\{TOTAL_ENTITIES_PHRASE\}\}/g, replacement);

    return new Response(body, {
        status: 200,
        headers: { ...HEADERS, ETag: etag },
    });
};
