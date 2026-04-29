/**
 * Phase 3: Hosted-On Data Collector
 * Queries Replicate, Together, and HF Inference APIs for available model lists.
 * Outputs hosted-on-{provider}.json to output/ for R2 upload.
 *
 * Usage: node scripts/factory/hosted-on-collector.js [--provider replicate|together|hf-inference]
 */

import fs from 'fs';
import path from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const TIMEOUT_MS = 30_000;

async function fetchJson(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return await res.json();
    } finally { clearTimeout(timer); }
}

async function collectReplicate() {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) { console.warn('[HOSTED-ON] REPLICATE_API_TOKEN not set, skipping'); return []; }
    const models = [];
    let url = 'https://api.replicate.com/v1/models?page_size=100';
    while (url && models.length < 5000) {
        const data = await fetchJson(url, { Authorization: `Bearer ${token}` });
        for (const m of (data.results || [])) {
            models.push({ id: `${m.owner}/${m.name}`, name: m.name, owner: m.owner });
        }
        url = data.next || null;
    }
    console.log(`[HOSTED-ON] Replicate: ${models.length} models`);
    return models;
}

async function collectTogether() {
    const key = process.env.TOGETHER_API_KEY;
    if (!key) { console.warn('[HOSTED-ON] TOGETHER_API_KEY not set, skipping'); return []; }
    const data = await fetchJson('https://api.together.ai/v1/models', {
        Authorization: `Bearer ${key}`,
    });
    const models = (Array.isArray(data) ? data : data.data || []).map(m => ({
        id: m.id, name: m.display_name || m.id, type: m.type || 'unknown',
    }));
    console.log(`[HOSTED-ON] Together: ${models.length} models`);
    return models;
}

async function collectHfInference() {
    const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const models = [];
    let url = 'https://huggingface.co/api/models?inference=warm&limit=1000&sort=downloads&direction=-1';
    while (url && models.length < 5000) {
        const data = await fetchJson(url, headers);
        if (!Array.isArray(data) || data.length === 0) break;
        for (const m of data) {
            models.push({ id: m.id || m.modelId, pipeline_tag: m.pipeline_tag || '' });
        }
        if (data.length < 1000) break;
        url = `https://huggingface.co/api/models?inference=warm&limit=1000&sort=downloads&direction=-1&offset=${models.length}`;
    }
    console.log(`[HOSTED-ON] HF Inference: ${models.length} models`);
    return models;
}

const PROVIDERS = {
    replicate: collectReplicate,
    together: collectTogether,
    'hf-inference': collectHfInference,
};

async function main() {
    const filter = process.argv.find(a => a.startsWith('--provider='))?.split('=')[1];
    const providers = filter ? { [filter]: PROVIDERS[filter] } : PROVIDERS;
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const timestamp = new Date().toISOString();

    for (const [name, collector] of Object.entries(providers)) {
        if (!collector) { console.error(`Unknown provider: ${name}`); continue; }
        try {
            const models = await collector();
            const out = { provider: name, collected_at: timestamp, count: models.length, models };
            const outPath = path.join(OUTPUT_DIR, `hosted-on-${name}.json`);
            fs.writeFileSync(outPath, JSON.stringify(out));
            console.log(`[HOSTED-ON] Written ${outPath} (${models.length} models)`);
        } catch (err) {
            console.error(`[HOSTED-ON] ${name} failed: ${err.message}`);
        }
    }
}

main().catch(err => { console.error('[HOSTED-ON] Fatal:', err); process.exit(1); });
