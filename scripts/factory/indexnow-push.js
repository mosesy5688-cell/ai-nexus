/**
 * IndexNow Incremental Push (V27.89 — true-delta manifest)
 *
 * Notifies IndexNow-participating engines (Bing / Yandex / Seznam / Naver; NOT Google)
 * about pages that genuinely changed this cycle.
 *
 * URL source: state/indexnow-delta.json — an array of page URLs emitted by the harvest
 * (merge-batches.js) for entities NEW this cycle, restored from R2 by the 4/4 job.
 * This replaces V27.84's sitemap <lastmod> scan, which submitted the whole catalog
 * (~459K URLs/cycle) because ingestion re-stamps last_modified catalog-wide — a quota/
 * blacklist risk. Deriving the delta at the change-memory layer is the correct source.
 *
 * Design: zero non-stdlib deps, fully non-blocking — every failure path exits 0 so it
 * can never stall the daily cycle. Verification key read from the public key file
 * (public by design; the engine fetches it to verify ownership). Skip-if-absent/empty.
 *
 * Flags: --dry-run (or INDEXNOW_DRY_RUN=1) prints the payload instead of posting.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = 'free2aitools.com';
const KEY_FILENAME = 'f2ai_indexnow_verify_key.txt';
const KEY_FILE_PATH = path.join(__dirname, '../../public/', KEY_FILENAME);
const DELTA_MANIFEST_PATH = path.join(__dirname, '../../state/indexnow-delta.json');
const KEY_LOCATION = `https://${HOST}/${KEY_FILENAME}`;
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

    if (!fs.existsSync(DELTA_MANIFEST_PATH)) {
        console.log('[IndexNow] True-delta manifest absent. Nothing to push this cycle.');
        process.exit(0);
    }

    let urls;
    try {
        urls = JSON.parse(fs.readFileSync(DELTA_MANIFEST_PATH, 'utf8') || '[]');
    } catch (err) {
        console.error(`[IndexNow] Manifest parse failed: ${err.message}. Safe exit.`);
        process.exit(0);
    }
    if (!Array.isArray(urls) || urls.length === 0) {
        console.log('[IndexNow] Zero changed pages in manifest this cycle. Execution clean.');
        process.exit(0);
    }

    const uniqueUrls = [...new Set(urls)];
    console.log(`[IndexNow] True-delta: ${uniqueUrls.length} changed page URLs to dispatch.`);

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
