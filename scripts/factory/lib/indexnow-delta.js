// IndexNow true-delta manifest writer (V27.89).
// Maps entity ids that are NEW this harvest cycle to canonical page URLs, written for the
// 4/4 IndexNow push step. Replaces V27.84's catalog-wide sitemap-lastmod scan (which
// re-submitted ~459K URLs/cycle because last_modified is re-stamped catalog-wide).
// Sanity-capped: a count near the full catalog means a registry rebuild, not real new
// pages, so we emit an empty manifest rather than blast IndexNow.
import fs from 'fs/promises';
import { getRouteFromId } from '../../../src/utils/mesh-routing-core.js';

const DELTA_CAP = 50000;
const OUT_PATH = 'output/data/indexnow-delta.json';

export async function writeIndexNowDelta(addedIds = []) {
    let urls = [];
    if (addedIds.length > DELTA_CAP) {
        console.warn(`[INDEXNOW-DELTA] ${addedIds.length} added > cap ${DELTA_CAP} — likely registry rebuild; emitting empty manifest.`);
    } else {
        urls = [...new Set(addedIds.map(({ id, type }) => {
            const route = getRouteFromId(id, type);
            return route && route !== '#' ? `https://free2aitools.com${route}` : null;
        }).filter(Boolean))];
    }
    await fs.mkdir('output/data', { recursive: true });
    await fs.writeFile(OUT_PATH, JSON.stringify(urls));
    console.log(`[INDEXNOW-DELTA] Wrote ${urls.length} new-page URLs (from ${addedIds.length} added).`);
    return urls.length;
}
