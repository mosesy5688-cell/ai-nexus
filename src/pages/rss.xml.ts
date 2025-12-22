/**
 * RSS Feed Endpoint - B.13 Weekly Report
 * Provides RSS 2.0 feed of recent AI models
 */

import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
    // Fetch recent models from cache
    let models: any[] = [];

    try {
        const env = (locals as any)?.runtime?.env;
        if (env?.CACHE_BUCKET) {
            const obj = await env.CACHE_BUCKET.get('cache/rankings.json');
            if (obj) {
                const text = await obj.text();
                models = JSON.parse(text).slice(0, 50); // Latest 50
            }
        }
    } catch (e) {
        console.error('[RSS] Error fetching models:', e);
    }

    const siteUrl = 'https://free2aitools.com';
    const now = new Date().toUTCString();

    // Build RSS XML
    const items = models.map(model => {
        const modelUrl = `${siteUrl}/model/${encodeURIComponent(model.slug || model.id)}`;
        const pubDate = model.lastModified
            ? new Date(model.lastModified).toUTCString()
            : now;
        const name = model.name || model.canonical_name || 'Unknown Model';
        const desc = (model.description || model.seo_summary || 'AI model').substring(0, 300);

        return `
    <item>
      <title><![CDATA[${name}]]></title>
      <link>${modelUrl}</link>
      <guid isPermaLink="true">${modelUrl}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${desc}]]></description>
      <author>${model.author || 'unknown'}</author>
    </item>`;
    }).join('\n');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Free2AITools - AI Model Updates</title>
    <link>${siteUrl}</link>
    <description>Latest AI models from Free2AITools</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml"/>
    <ttl>60</ttl>
    ${items}
  </channel>
</rss>`;

    return new Response(rss, {
        status: 200,
        headers: {
            'Content-Type': 'application/rss+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
        },
    });
};
