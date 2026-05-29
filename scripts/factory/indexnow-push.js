/**
 * IndexNow Incremental Push (V27.84)
 *
 * Notifies IndexNow-participating engines (Bing / Yandex / Seznam / Naver; NOT Google)
 * about recently-changed pages, so they re-crawl without waiting for sitemap polling.
 *
 * URL source: the page URLs the frozen V19.2 sitemap generator already emits into
 * output/sitemaps/sitemap-*.xml, filtered by recent <lastmod>. (NOT purge-list.json,
 * which is R2 asset-path cache invalidation on the cdn. subdomain, not crawlable pages.)
 *
 * Design: O(1) streaming line-parse (no XML DOM), zero non-stdlib deps. Fully
 * non-blocking — every failure path exits 0 so it can never stall the daily cycle.
 * Verification key is read from public/f2ai_indexnow_verify_key.txt FILE CONTENT
 * (public by design; the engine fetches it to verify ownership). Skip-if-absent.
 *
 * Flags: --dry-run (or INDEXNOW_DRY_RUN=1) prints the payload instead of posting.
 * Env:   INDEXNOW_LOOKBACK_HOURS (default 48).
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = 'free2aitools.com';
const KEY_FILENAME = 'f2ai_indexnow_verify_key.txt';
const KEY_FILE_PATH = path.join(__dirname, '../../public/', KEY_FILENAME);
const SITEMAPS_DIR = path.join(__dirname, '../../output/sitemaps');
const KEY_LOCATION = `https://${HOST}/${KEY_FILENAME}`;
const LOOKBACK_HOURS = parseFloat(process.env.INDEXNOW_LOOKBACK_HOURS || '48');
const BATCH_SIZE = 10000;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.INDEXNOW_DRY_RUN === '1';

function postBatch(key, urlList) {
    const payload = JSON.stringify({
        host: HOST,
        key: key,
        keyLocation: KEY_LOCATION,
        urlList: urlList,
    });

    if (DRY_RUN) {
        console.log(`[IndexNow] DRY-RUN payload (${urlList.length} URLs): ${payload.slice(0, 400)}`);
        return Promise.resolve(true);
    }

    return new Promise((resolve) => {
        const options = {
            hostname: 'api.indexnow.org',
            port: 443,
            path: '/indexnow',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 15000,
        };
        const req = https.request(options, (res) => {
            console.log(`[IndexNow] Broadcast response status: ${res.statusCode}`);
            res.resume();
            resolve(res.statusCode === 200 || res.statusCode === 202);
        });
        req.on('error', (err) => {
            console.error(`[IndexNow] Telemetry post failed non-blockingly: ${err.message}`);
            resolve(false);
        });
        req.on('timeout', () => {
            req.destroy();
            console.error('[IndexNow] Request timed out reaching api.indexnow.org');
            resolve(false);
        });
        req.write(payload);
        req.end();
    });
}

async function parseSitemapFile(filePath, cutoffTime, urls) {
    if (!fs.existsSync(filePath)) return;
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let currentLoc = null;
    let currentLastMod = null;

    for await (const line of rl) {
        const locMatch = line.match(/<loc>(.*?)<\/loc>/);
        const lastmodMatch = line.match(/<lastmod>(.*?)<\/lastmod>/);
        if (locMatch) currentLoc = locMatch[1].trim();
        if (lastmodMatch) currentLastMod = lastmodMatch[1].trim();
        if (line.includes('</url>')) {
            if (currentLoc && currentLastMod) {
                const modTime = new Date(currentLastMod).getTime();
                if (!isNaN(modTime) && modTime >= cutoffTime) {
                    urls.push(currentLoc);
                }
            }
            currentLoc = null;
            currentLastMod = null;
        }
    }
}

async function run() {
    if (!fs.existsSync(KEY_FILE_PATH)) {
        console.log('[IndexNow] Invariant verify key file absent. Gating execution smoothly.');
        process.exit(0);
    }

    const key = fs.readFileSync(KEY_FILE_PATH, 'utf8').trim();
    if (!key || !/^[a-z0-9]{32,40}$/i.test(key)) {
        console.error('[IndexNow] Key failed sanity pattern matching. Aborting script.');
        process.exit(0);
    }

    if (!fs.existsSync(SITEMAPS_DIR)) {
        console.log('[IndexNow] Sitemaps build directory missing. Zero mutations to push.');
        process.exit(0);
    }

    const files = fs.readdirSync(SITEMAPS_DIR)
        .filter((f) => f.startsWith('sitemap-') && f.endsWith('.xml'));
    const urls = [];
    const cutoffTime = Date.now() - (LOOKBACK_HOURS * 60 * 60 * 1000);
    console.log(`[IndexNow] Analyzing ${files.length} sitemap shards for lookback: ${LOOKBACK_HOURS}h`);

    for (const file of files) {
        await parseSitemapFile(path.join(SITEMAPS_DIR, file), cutoffTime, urls);
    }

    if (urls.length === 0) {
        console.log('[IndexNow] Zero mutated pages found within lookback window. Execution clean.');
        process.exit(0);
    }

    const uniqueUrls = [...new Set(urls)];
    console.log(`[IndexNow] Discovered ${uniqueUrls.length} unique filtered changes to dispatch.`);

    for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
        const batch = uniqueUrls.slice(i, i + BATCH_SIZE);
        console.log(`[IndexNow] Posting batch ${i / BATCH_SIZE + 1} (${batch.length} URLs)`);
        await postBatch(key, batch);
    }
}

run().catch((err) => {
    console.error(`[IndexNow] Critical execution error bypassed safely: ${err.message}`);
    process.exit(0);
});
