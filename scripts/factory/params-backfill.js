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

function hfHeaders() {
    const h = { 'Accept': 'application/json', 'User-Agent': 'Free2AITools/2.1' };
    if (HF_TOKEN) h['Authorization'] = `Bearer ${HF_TOKEN}`;
    return h;
}

function extractParamsFromName(name) {
    const match = (name || '').match(/(\d+(?:\.\d+)?)\s*[Bb]/);
    return match ? parseFloat(match[1]) : null;
}

async function fetchParamsFromHF(modelId) {
    try {
        const hfId = modelId.replace(/^hf-model--/, '').replace(/--/g, '/');
        const res = await fetch(`${HF_API}/${hfId}?expand[]=safetensors&expand[]=config`, {
            headers: hfHeaders(),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const paramsRaw = data.safetensors?.total || data.config?.num_parameters;
        if (paramsRaw) return parseFloat((paramsRaw / 1e9).toFixed(2));
        return extractParamsFromName(data.modelId || hfId);
    } catch (e) { console.warn(`[PARAMS-BACKFILL] ${modelId}: ${e.message}`); return null; }
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

    const missing = [];
    await loadRegistryShardsSequentially(async (entities) => {
        for (const e of entities) {
            if (missing.length >= LIMIT) return;
            if (e.id?.startsWith('hf-model--') && (!e.params_billions || e.params_billions === 0)) {
                if (cache[e.id]) continue;
                const nameParams = extractParamsFromName(e.name || e.id);
                if (nameParams) { cache[e.id] = nameParams; continue; }
                missing.push(e.id);
            }
        }
    }, { slim: true });

    console.log(`[PARAMS-BACKFILL] Missing: ${missing.length} models (after name regex + cache filter)`);
    if (DRY_RUN) { console.log('[PARAMS-BACKFILL] Dry run — skipping HF API calls'); return; }

    let fetched = 0, found = 0;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        for (const id of batch) {
            const params = await fetchParamsFromHF(id);
            fetched++;
            if (params) { cache[id] = params; found++; }
        }
        if (i + BATCH_SIZE < missing.length) await new Promise(r => setTimeout(r, DELAY_MS));
        if (fetched % 200 === 0) console.log(`[PARAMS-BACKFILL] Progress: ${fetched}/${missing.length} fetched, ${found} found`);
    }

    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const compressed = await zstdCompress(Buffer.from(JSON.stringify(cache)));
    fs.writeFileSync(CACHE_PATH, compressed);
    console.log(`[PARAMS-BACKFILL] ✅ Complete: ${found}/${fetched} resolved, cache size: ${Object.keys(cache).length} (${(compressed.length/1024).toFixed(1)}KB Zstd)`);
}

main().catch(err => { console.error('[PARAMS-BACKFILL] Fatal:', err); process.exit(1); });
