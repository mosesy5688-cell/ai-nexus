/**
 * S2ORC Fulltext Importer — V26.6
 *
 * Downloads S2ORC bulk dataset files from Semantic Scholar Datasets API,
 * streams each file, and extracts fulltext for papers matching our
 * unenriched arXiv IDs. Writes to R2 enrichment/fulltext/ path.
 *
 * Usage: node scripts/factory/s2orc-importer.js [--max-files=5]
 * Env: S2_API_KEY, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID
 */

import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import { getEnrichmentQueue, markEnriched } from './lib/dedup-manager.js';
import { initR2Bridge, createR2ClientFFI, uploadBufferToR2FFI } from './lib/r2-bridge.js';
import { zstdCompress } from './lib/zstd-helper.js';
import { generateUMID } from './lib/umid-generator.js';

const S2_API_KEY = process.env.S2_API_KEY || '';
const S2_DATASETS_BASE = 'https://api.semanticscholar.org/datasets/v1';
const MAX_FILES = parseInt(process.argv.find(a => a.startsWith('--max-files='))?.split('=')[1] || '30');
const MAX_RUNTIME_MS = 5 * 60 * 60 * 1000;

function s2Headers() {
    const h = { 'Accept': 'application/json' };
    if (S2_API_KEY) h['x-api-key'] = S2_API_KEY;
    return h;
}

async function getS2orcFileUrls() {
    const res = await fetch(`${S2_DATASETS_BASE}/release/latest`, { headers: s2Headers() });
    if (!res.ok) throw new Error(`Datasets API: ${res.status}`);
    const data = await res.json();
    const s2orc = data.datasets?.find(d => d.name === 's2orc') || data.datasets?.find(d => d.name === 's2orc_v2');
    if (!s2orc) throw new Error('s2orc dataset not found in latest release');

    const detailRes = await fetch(s2orc.url || `${S2_DATASETS_BASE}/release/latest/dataset/s2orc`, { headers: s2Headers() });
    if (!detailRes.ok) throw new Error(`Dataset detail: ${detailRes.status}`);
    const detail = await detailRes.json();
    return detail.files || [];
}

function extractArxivId(externalIds) {
    if (!externalIds) return null;
    if (externalIds.ArXiv) return externalIds.ArXiv.replace(/v\d+$/, '');
    return null;
}

async function buildArxivLookup() {
    const queue = getEnrichmentQueue('00', 'ff', 50000);
    const lookup = new Map();
    for (const p of queue) {
        const match = p.canonical_id?.match(/(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i);
        if (match) lookup.set(match[1].replace(/v\d+$/, ''), p);
    }
    console.log(`[S2ORC] Built arXiv lookup: ${lookup.size} unenriched papers`);
    return lookup;
}

async function streamS2orcFile(fileUrl, arxivLookup, s3) {
    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(600000) });
    if (!res.ok) throw new Error(`Download: ${res.status}`);

    const gunzip = createGunzip();
    Readable.fromWeb(res.body).pipe(gunzip);
    const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

    let scanned = 0, matched = 0;
    const enrichedUmids = [];

    for await (const line of rl) {
        scanned++;
        if (scanned % 100000 === 0) console.log(`[S2ORC]   Scanned ${scanned} papers, matched ${matched}`);

        let paper;
        try { paper = JSON.parse(line); } catch { continue; }

        const arxivId = extractArxivId(paper.externalids || paper.externalIds);
        if (!arxivId || !arxivLookup.has(arxivId)) continue;

        const fulltext = paper.content?.text || paper.fullText || '';
        if (fulltext.length < 200) continue;

        const entry = arxivLookup.get(arxivId);
        const umid = entry.umid || generateUMID(entry.canonical_id);
        const partition = umid.substring(0, 2);
        const key = `enrichment/fulltext/${partition}/${umid}.md.zst`;

        try {
            const compressed = await zstdCompress(fulltext);
            await uploadBufferToR2FFI(s3, key, compressed, 'application/zstd');
            enrichedUmids.push(umid);
            matched++;
            arxivLookup.delete(arxivId);
            console.log(`   ✅ ${arxivId} (${fulltext.length} chars)`);
        } catch (e) {
            console.warn(`   ❌ ${arxivId}: ${e.message}`);
        }
    }

    if (enrichedUmids.length > 0) markEnriched(enrichedUmids);
    return { scanned, matched };
}

async function main() {
    if (!S2_API_KEY) { console.error('[S2ORC] S2_API_KEY required'); process.exit(1); }
    console.log('[S2ORC] V26.6 S2ORC Fulltext Importer');
    const startTime = Date.now();

    initR2Bridge();
    const s3 = createR2ClientFFI();
    if (!s3) { console.error('[S2ORC] R2 client init failed'); process.exit(1); }

    const arxivLookup = await buildArxivLookup();
    if (arxivLookup.size === 0) { console.log('[S2ORC] No unenriched papers. Done.'); return; }

    let fileUrls;
    try { fileUrls = await getS2orcFileUrls(); } catch (e) {
        console.error(`[S2ORC] Failed to get file list: ${e.message}`);
        process.exit(1);
    }
    console.log(`[S2ORC] ${fileUrls.length} S2ORC files available (processing max ${MAX_FILES})`);

    let totalScanned = 0, totalMatched = 0;
    const filesToProcess = fileUrls.slice(0, MAX_FILES);

    for (let i = 0; i < filesToProcess.length; i++) {
        if (Date.now() - startTime > MAX_RUNTIME_MS) { console.log('[S2ORC] Runtime limit reached'); break; }
        if (arxivLookup.size === 0) { console.log('[S2ORC] All papers matched!'); break; }

        console.log(`[S2ORC] File ${i + 1}/${filesToProcess.length} (${arxivLookup.size} remaining)`);
        try {
            const { scanned, matched } = await streamS2orcFile(filesToProcess[i], arxivLookup, s3);
            totalScanned += scanned;
            totalMatched += matched;
        } catch (e) {
            console.warn(`[S2ORC] File ${i + 1} failed: ${e.message}`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[S2ORC] ✅ Complete in ${elapsed}min`);
    console.log(`[S2ORC]   Scanned: ${totalScanned} | Matched: ${totalMatched} | Remaining: ${arxivLookup.size}`);
}

main().catch(err => { console.error('[S2ORC] Fatal:', err); process.exit(1); });
