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

// V27.88: Open LLM Leaderboard v2 schema. The v1 columns (HumanEval/MBPP/GSM8K/
// HellaSwag/ARC) no longer exist in open-llm-leaderboard/contents; the live dataset
// exposes IFEval/BBH/MATH Lvl 5/GPQA/MUSR/MMLU-PRO (+ 'Average <emoji>'). Reading v1
// names was a silent-strip: only MMLU-PRO matched (mislabeled 'mmlu'), rest dropped.
const V2_COLUMNS = {
    'IFEval': 'ifeval',
    'BBH': 'bbh',
    'MATH Lvl 5': 'math_lvl5',
    'GPQA': 'gpqa',
    'MUSR': 'musr',
    'MMLU-PRO': 'mmlu_pro',
};

function normalizeBenchmarks(row) {
    const r = row?.row || row || {};
    const toNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; };
    const out = {};
    for (const [col, key] of Object.entries(V2_COLUMNS)) {
        const v = toNum(r[col]);
        if (v !== undefined) out[key] = v;
    }
    // 'Average' column carries a trailing unicode emoji + whitespace ('Average <emoji>'),
    // so match tolerantly by prefix instead of an exact literal that could silently drop.
    const avgCol = Object.keys(r).find((k) => /^average/i.test(k.trim()));
    if (avgCol) { const v = toNum(r[avgCol]); if (v !== undefined) out.average = v; }
    return Object.keys(out).length > 0 ? out : null;
}

function normalizeModelKey(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
    console.log('[BENCHMARK] V26.7 Open LLM Leaderboard Importer');

    // V27.88: cache self-heal. The append-only guard below (`if (!cache[key])`) traps
    // old v1-schema stubs forever, so a schema bump must discard the stale cache once.
    // The '__schema' stamp auto-rebuilds on the next cron without a manual dispatch.
    const SCHEMA = 'v2';
    const forceRebuild = process.argv.includes('--force-rebuild');
    let cache = {};
    try {
        const buf = await autoDecompress(fs.readFileSync(CACHE_PATH));
        cache = JSON.parse(buf.toString('utf-8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[BENCHMARK] Cache load: ${e.message}`);
    }
    if (forceRebuild || cache.__schema !== SCHEMA) {
        const stale = Object.keys(cache).filter((k) => k !== '__schema').length;
        console.log(`[BENCHMARK] Schema rebuild: ${cache.__schema || 'none'} -> ${SCHEMA} (force=${forceRebuild}); discarding ${stale} stale entries.`);
        cache = {};
    }
    cache.__schema = SCHEMA;
    console.log(`[BENCHMARK] Loaded ${Object.keys(cache).length - 1} cached benchmarks (schema ${SCHEMA})`);

    let offset = 0, fetched = 0, added = 0;
    const PAGE_SIZE = 100;

    while (fetched < LIMIT) {
        const url = `https://datasets-server.huggingface.co/rows?dataset=open-llm-leaderboard%2Fcontents&config=default&split=train&offset=${offset}&length=${PAGE_SIZE}`;
        let data;
        try {
            const res = await fetch(url, { headers: hfHeaders(), signal: AbortSignal.timeout(30000) });
            if (!res.ok) {
                console.error(`[BENCHMARK] FATAL: page offset=${offset} HTTP ${res.status} — stopping import (collected ${fetched} rows, ${added} new)`);
                break;
            }
            data = await res.json();
        } catch (e) {
            console.error(`[BENCHMARK] FATAL: page offset=${offset} ${e.message} — stopping import (collected ${fetched} rows, ${added} new)`);
            break;
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
    console.log(`[BENCHMARK] ✅ Complete: ${added} new, cache=${Object.keys(cache).length - 1} (${(compressed.length/1024).toFixed(1)}KB Zstd)`);
}

main().catch(err => { console.error('[BENCHMARK] Fatal:', err); process.exit(1); });
