/**
 * V26.7 Benchmark Importer — Fetch HF Open LLM Leaderboard scores.
 *
 * Pulls HumanEval/MBPP/MMLU/GSM8K/HellaSwag/ARC for models, joins via
 * model_id, stores in R2 cache for persistence.
 *
 * Usage: node scripts/factory/benchmark-importer.js [--limit=10000]
 */

import fs from 'fs';
import path from 'path';
import { zstdCompress, autoDecompress } from './lib/zstd-helper.js';

const HF_TOKEN = process.env.HF_TOKEN || '';
const LEADERBOARD_URL = 'https://huggingface.co/api/datasets/open-llm-leaderboard/contents-public/parquet/default/train';
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '10000');
const CACHE_PATH = process.env.BENCHMARK_CACHE_PATH || './output/data/benchmark-cache.json.zst';

function hfHeaders() {
    const h = { 'Accept': 'application/json', 'User-Agent': 'Free2AITools/2.1' };
    if (HF_TOKEN) h['Authorization'] = `Bearer ${HF_TOKEN}`;
    return h;
}

async function fetchLeaderboardRows() {
    const url = `https://datasets-server.huggingface.co/rows?dataset=open-llm-leaderboard%2Fcontents&config=default&split=train&offset=0&length=100`;
    const res = await fetch(url, { headers: hfHeaders(), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Leaderboard fetch ${res.status}`);
    return res.json();
}

function normalizeBenchmarks(row) {
    const r = row?.row || row || {};
    const out = {};
    if (r['HumanEval']) out.humaneval = parseFloat(r['HumanEval']);
    if (r['MBPP']) out.mbpp = parseFloat(r['MBPP']);
    if (r['MMLU-PRO'] || r['MMLU']) out.mmlu = parseFloat(r['MMLU-PRO'] || r['MMLU']);
    if (r['GSM8K']) out.gsm8k = parseFloat(r['GSM8K']);
    if (r['HellaSwag']) out.hellaswag = parseFloat(r['HellaSwag']);
    if (r['ARC']) out.arc = parseFloat(r['ARC']);
    if (r['Average']) out.average = parseFloat(r['Average']);
    return Object.keys(out).length > 0 ? out : null;
}

function normalizeModelKey(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
    console.log('[BENCHMARK] V26.7 Open LLM Leaderboard Importer');

    let cache = {};
    try {
        const buf = await autoDecompress(fs.readFileSync(CACHE_PATH));
        cache = JSON.parse(buf.toString('utf-8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[BENCHMARK] Cache load: ${e.message}`);
    }
    console.log(`[BENCHMARK] Loaded ${Object.keys(cache).length} cached benchmarks`);

    let offset = 0, fetched = 0, added = 0;
    const PAGE_SIZE = 100;

    while (fetched < LIMIT) {
        const url = `https://datasets-server.huggingface.co/rows?dataset=open-llm-leaderboard%2Fcontents&config=default&split=train&offset=${offset}&length=${PAGE_SIZE}`;
        let data;
        try {
            const res = await fetch(url, { headers: hfHeaders(), signal: AbortSignal.timeout(30000) });
            if (!res.ok) { console.warn(`[BENCHMARK] page ${offset}: ${res.status}`); break; }
            data = await res.json();
        } catch (e) {
            console.warn(`[BENCHMARK] page ${offset} error: ${e.message}`); break;
        }
        const rows = data?.rows || [];
        if (rows.length === 0) break;

        for (const row of rows) {
            const r = row?.row || {};
            const modelName = r['fullname'] || r['Model'] || r['model_id'];
            if (!modelName) continue;
            const bench = normalizeBenchmarks(row);
            if (!bench) continue;
            const key = normalizeModelKey(modelName);
            if (!cache[key]) { cache[key] = { name: modelName, ...bench }; added++; }
            fetched++;
        }
        offset += PAGE_SIZE;
        if (fetched % 500 === 0) console.log(`[BENCHMARK] Progress: ${fetched} rows, ${added} new`);
        await new Promise(r => setTimeout(r, 300));
    }

    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const compressed = await zstdCompress(Buffer.from(JSON.stringify(cache)));
    fs.writeFileSync(CACHE_PATH, compressed);
    console.log(`[BENCHMARK] ✅ Complete: ${added} new, cache=${Object.keys(cache).length} (${(compressed.length/1024).toFixed(1)}KB Zstd)`);
}

main().catch(err => { console.error('[BENCHMARK] Fatal:', err); process.exit(1); });
