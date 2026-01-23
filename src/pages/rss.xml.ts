/**
 * RSS Feed Endpoint - B.13 Weekly Report
 * Provides RSS 2.0 feed of recent AI models
 */

import type { APIRoute } from 'astro';

export const prerender = true;

const CDN_URL = 'https://cdn.free2aitools.com/cache/search-core.json';

export const GET: APIRoute = async () => {
    // Fetch recent models from CDN (Static)
    let models: any[] = [];

    try {
        const res = await fetch(CDN_URL);
        if (res.ok) {
            const data = await res.json();
            models = (data.entities || data.models || data);
        }
    } catch (e) {
        console.error('[RSS] Error fetching models from CDN:', e);
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
        const desc = (model.description || model.seo_summary || 'AI model');

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
