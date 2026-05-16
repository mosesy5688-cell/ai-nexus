/**
 * V26.6 Params Backfill — Batch-fill missing params_billions from HF API.
 *
 * Scans registry for entities with params_billions = 0/null,
 * queries HF API for safetensors/config data, writes results
 * to R2 cache for persistence across pipeline runs.
 *
 * Usage: node scripts/factory/params-backfill.js [--limit=5000] [--dry-run]
 * Env: HF_TOKEN (optional, higher rate limit)
 */

import fs from 'fs';
import path from 'path';
import { loadRegistryShardsSequentially } from './lib/registry-loader.js';
import { zstdCompress, autoDecompress } from './lib/zstd-helper.js';

const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_API = 'https://huggingface.co/api/models';
const BATCH_SIZE = 50;
const DELAY_MS = 500;
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '5000');
const DRY_RUN = process.argv.includes('--dry-run');
const CACHE_PATH = process.env.PARAMS_CACHE_PATH || './output/data/params-cache.json.zst';

// V27.6: Persistent retry-queue for failed CIDs.
// Without this, every cron re-queries known-failed CIDs (401 gated / 404
// deleted / 200_no_params / etc.) burning HF API quota on entries that
// will keep failing for the same reason. Same shape as Sciweon
// harvest-retry-queue.js (PR #19), adapted to Free2AITools scale.
const FAILED_CACHE_PATH = process.env.PARAMS_FAILED_CACHE_PATH || './output/data/params-failed-cids.json.zst';
const MAX_FAILURE_ATTEMPTS = 5;             // After N attempts, mark exhausted
const RETRY_AFTER_HOURS = 168;              // Exhausted CIDs retry after 7 days
const RETRY_AFTER_MS = RETRY_AFTER_HOURS * 3600 * 1000;

function hfHeaders() {
    const h = { 'Accept': 'application/json', 'User-Agent': 'Free2AITools/2.1' };
    if (HF_TOKEN) h['Authorization'] = `Bearer ${HF_TOKEN}`;
    return h;
}

function extractParamsFromName(name) {
    const s = name || '';
    const match = s.match(/(\d+(?:\.\d+)?)\s*[Bb](?![a-zA-Z])/);
    if (!match) return null;
    const v = parseFloat(match[1]);
    if (v < 0.1 || v > 2000) return null;
    return v;
}

// V27.4: bucket-classify every HF response so a low yield run can be attributed
// to genuine "no data" vs blocked (401 gated / 403 / 404 / 429 / 5xx / network).
// params-backfill previously collapsed all non-200 to null indistinguishably,
// hiding upstream issues behind a single "X/Y resolved" headline.
const STATUS_BUCKETS = ['200_with_params', '200_no_params', '401_gated', '403_forbidden',
    '404_not_found', '429_rate_limited', '5xx', 'timeout', 'network_error', 'other'];

async function fetchParamsFromHF(modelId, counts) {
    let hfId;
    try {
        hfId = modelId.replace(/^hf-model--/, '').replace(/--/g, '/');
        const res = await fetch(`${HF_API}/${hfId}?expand[]=safetensors&expand[]=config`, {
            headers: hfHeaders(),
            signal: AbortSignal.timeout(15000),
        });
        const s = res.status;
        if (s === 200) {
            const data = await res.json();
            const paramsRaw = data.safetensors?.total || data.config?.num_parameters;
            if (paramsRaw) { counts['200_with_params']++; return { params: parseFloat((paramsRaw / 1e9).toFixed(2)), bucket: '200_with_params' }; }
            const fromName = extractParamsFromName(data.modelId || hfId);
            const bucket = fromName ? '200_with_params' : '200_no_params';
            counts[bucket]++;
            return { params: fromName, bucket };
        }
        let bucket = 'other';
        if (s === 401) bucket = '401_gated';
        else if (s === 403) bucket = '403_forbidden';
        else if (s === 404) bucket = '404_not_found';
        else if (s === 429) bucket = '429_rate_limited';
        else if (s >= 500) bucket = '5xx';
        counts[bucket]++;
        return { params: null, bucket };
    } catch (e) {
        const isTimeout = e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message);
        const bucket = isTimeout ? 'timeout' : 'network_error';
        counts[bucket]++;
        console.warn(`[PARAMS-BACKFILL] ${modelId}: ${e.message}`);
        return { params: null, bucket };
    }
}

// V27.6: Retry-queue helpers. Failures stored as {bucket, attempts, first, last}.
// Eligibility rule: until attempts >= MAX, retry every cycle. After MAX,
// wait RETRY_AFTER_MS before next attempt — turns retries from O(N*cycles)
// into O(N) + sparse polling.
function shouldRetryFailure(entry) {
    if (!entry || entry.attempts < MAX_FAILURE_ATTEMPTS) return true;
    const last = Date.parse(entry.last || 0);
    return (Date.now() - last) > RETRY_AFTER_MS;
}

function recordFailure(failures, id, bucket) {
    const now = new Date().toISOString();
    const existing = failures[id];
    failures[id] = existing
        ? { ...existing, bucket, attempts: existing.attempts + 1, last: now }
        : { bucket, attempts: 1, first: now, last: now };
}

async function main() {
    console.log(`[PARAMS-BACKFILL] Scanning registry for missing params...`);

    let cache = {};
    try {
        const buf = await autoDecompress(fs.readFileSync(CACHE_PATH));
        cache = JSON.parse(buf.toString('utf-8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[PARAMS-BACKFILL] Cache load failed (${e.code || 'unknown'}): ${e.message}`);
    }
    console.log(`[PARAMS-BACKFILL] Loaded ${Object.keys(cache).length} cached entries`);

    // V27.6: Load persistent retry-queue. CIDs that previously failed are
    // skipped unless eligible for retry (attempts < MAX, or cooldown elapsed).
    let failures = {};
    try {
        const buf = await autoDecompress(fs.readFileSync(FAILED_CACHE_PATH));
        failures = JSON.parse(buf.toString('utf-8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[PARAMS-BACKFILL] Failures cache load failed (${e.code || 'unknown'}): ${e.message}`);
    }
    const failuresIn = Object.keys(failures).length;
    let skippedByRetryQueue = 0;
    console.log(`[PARAMS-BACKFILL] Loaded ${failuresIn} failure entries (skip eligible: ${Object.values(failures).filter(f => !shouldRetryFailure(f)).length})`);

    const missing = [];
    await loadRegistryShardsSequentially(async (entities) => {
        for (const e of entities) {
            if (missing.length >= LIMIT) return;
            if (e.id?.startsWith('hf-model--') && (!e.params_billions || e.params_billions === 0)) {
                if (cache[e.id]) continue;
                const nameParams = extractParamsFromName(e.name || e.id);
                if (nameParams) { cache[e.id] = nameParams; continue; }
                // V27.6: skip known-failed CIDs not yet eligible for retry
                if (failures[e.id] && !shouldRetryFailure(failures[e.id])) {
                    skippedByRetryQueue++;
                    continue;
                }
                missing.push(e.id);
            }
        }
    }, { slim: true });

    console.log(`[PARAMS-BACKFILL] Missing: ${missing.length} models (after name regex + cache filter)`);
    if (DRY_RUN) { console.log('[PARAMS-BACKFILL] Dry run — skipping HF API calls'); return; }

    let fetched = 0, found = 0;
    const counts = Object.fromEntries(STATUS_BUCKETS.map(k => [k, 0]));
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        for (const id of batch) {
            const { params, bucket } = await fetchParamsFromHF(id, counts);
            fetched++;
            if (params != null) {
                cache[id] = params;
                delete failures[id]; // V27.6: success clears any prior failure record
                found++;
            } else {
                recordFailure(failures, id, bucket);
            }
        }
        if (i + BATCH_SIZE < missing.length) await new Promise(r => setTimeout(r, DELAY_MS));
        if (fetched % 200 === 0) console.log(`[PARAMS-BACKFILL] Progress: ${fetched}/${missing.length} fetched, ${found} found`);
    }

    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const compressed = await zstdCompress(Buffer.from(JSON.stringify(cache)));
    fs.writeFileSync(CACHE_PATH, compressed);
    // V27.6: persist failure queue alongside resolved cache so next cycle reads it
    fs.mkdirSync(path.dirname(FAILED_CACHE_PATH), { recursive: true });
    const failuresCompressed = await zstdCompress(Buffer.from(JSON.stringify(failures)));
    fs.writeFileSync(FAILED_CACHE_PATH, failuresCompressed);
    const failuresOut = Object.keys(failures).length;
    const exhausted = Object.values(failures).filter(f => f.attempts >= MAX_FAILURE_ATTEMPTS).length;
    console.log(`[PARAMS-BACKFILL] ✅ Complete: ${found}/${fetched} resolved, cache size: ${Object.keys(cache).length} (${(compressed.length/1024).toFixed(1)}KB Zstd)`);
    console.log(`[PARAMS-BACKFILL] Retry queue: ${failuresIn} in -> ${failuresOut} out, ${exhausted} exhausted (>=${MAX_FAILURE_ATTEMPTS} attempts, ${RETRY_AFTER_HOURS}h cooldown), ${skippedByRetryQueue} skipped this cycle (${(failuresCompressed.length/1024).toFixed(1)}KB Zstd)`);
    const breakdown = STATUS_BUCKETS.filter(k => counts[k] > 0).map(k => `${k}=${counts[k]}`).join(', ');
    console.log(`[PARAMS-BACKFILL] HF response breakdown: ${breakdown || '(no fetches)'}`);
    const blocked = counts['401_gated'] + counts['403_forbidden'] + counts['404_not_found']
        + counts['429_rate_limited'] + counts['5xx'] + counts['timeout'] + counts['network_error'];
    if (fetched > 0 && blocked / fetched > 0.05) {
        console.warn(`[PARAMS-BACKFILL] ⚠ Blocked/error ratio ${((blocked/fetched)*100).toFixed(1)}% > 5% — investigate upstream`);
    }
}

main().catch(err => { console.error('[PARAMS-BACKFILL] Fatal:', err); process.exit(1); });
