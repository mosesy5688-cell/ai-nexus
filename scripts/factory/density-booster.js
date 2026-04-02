import { initR2Bridge, createR2ClientFFI, fetchAllR2ETagsFFI, uploadBufferToR2FFI } from './lib/r2-bridge.js';
import { getEnrichmentQueue, markEnriched } from './lib/dedup-manager.js';
import { initRustBridge, extractAndClassifyFFI, classifyTextFFI } from './lib/rust-bridge.js';
import { zstdCompress } from './lib/zstd-helper.js';
import { primeSession, extractArxivId, fetchOfficialHtml, fetchAr5ivHtml, fetchS2Fulltext, initMarkerSidecar, fetchArxivPdf, shutdownMarkerSidecar } from './lib/arxiv-fetchers.js';

// ── HF README Fetcher (for model enrichment) ───────────
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_HEADERS = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
async function fetchHfReadme(modelId) {
    try {
        const url = `https://huggingface.co/${modelId}/raw/main/README.md`;
        const res = await fetch(url, { headers: HF_HEADERS, signal: AbortSignal.timeout(15000) });
        if (!res.ok) return null;
        const text = await res.text();
        return text.length >= 200 ? text : null;
    } catch { return null; }
}

// ── Config ──────────────────────────────────────────────
const RATE_LIMIT_MS = 10000;
const AR5IV_RETRY_DELAY_MS = 8000;
const BUDGET = 20000;
const MAX_RUNTIME_MS = 5 * 60 * 60 * 1000;
const S2_RUNNER_BUDGET = 1250; 
const BREAKER_THRESHOLD = 5;
const BREAKER_PAUSE_MS = 2 * 60 * 1000;
const BREAKER_RECOVERY_DELAY = 10000;

// ── Args ────────────────────────────────────────────────
const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
        const [k, v] = a.substring(2).split('=');
        return [k, v];
    })
);
const PARTITION_START = args['partition-start'] || '00';
const PARTITION_END = args['partition-end'] || 'ff';

// ── Circuit Breaker State ───────────────────────────────
let consecutiveFailures = 0;
let baseDelay = RATE_LIMIT_MS;

async function rateLimitPause() {
    await new Promise(r => setTimeout(r, baseDelay));
}

async function handleFailure() {
    consecutiveFailures++;
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
        console.warn(`[BOOSTER] Circuit breaker tripped (${consecutiveFailures} failures). Pausing ${BREAKER_PAUSE_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, BREAKER_PAUSE_MS));
        consecutiveFailures = 0;
        baseDelay = BREAKER_RECOVERY_DELAY;
    }
}

function handleSuccess() {
    consecutiveFailures = 0;
    if (baseDelay > RATE_LIMIT_MS) baseDelay = RATE_LIMIT_MS;
}

// ── Pre-sweep R2 ────────────────────────────────────────
async function buildAlreadyEnrichedSet(s3) {
    const enrichedSet = new Set();
    const prefixes = [];
    const start = parseInt(PARTITION_START, 16);
    const end = parseInt(PARTITION_END, 16);
    for (let i = start; i <= end; i++) {
        prefixes.push(`enrichment/fulltext/${i.toString(16).padStart(2, '0')}/`);
    }
    const etags = await fetchAllR2ETagsFFI(s3, prefixes);
    for (const key of etags.keys()) {
        const m = key.match(/\/([a-f0-9]+)\.md\.(?:gz|zst)$/);
        if (m) enrichedSet.add(m[1]);
    }
    return enrichedSet;
}

// ── Main ────────────────────────────────────────────────
async function main() {
    console.log(`[BOOSTER] V25.8.7 Density Booster starting [${PARTITION_START}..${PARTITION_END}]`);
    const startTime = Date.now();

    const rustStatus = initRustBridge();
    await primeSession();
    const markerReady = await initMarkerSidecar();
    if (markerReady) console.log('[BOOSTER] Marker PDF sidecar ready.');
    else console.warn('[BOOSTER] Marker unavailable. PDF fallback disabled.');

    initR2Bridge();
    const s3 = createR2ClientFFI();
    if (!s3) process.exit(1);

    const alreadyEnriched = await buildAlreadyEnrichedSet(s3);
    const queue = getEnrichmentQueue(PARTITION_START, PARTITION_END, BUDGET);
    const workQueue = queue.filter(p => !alreadyEnriched.has(p.umid));
    const papers = workQueue.filter(e => e.type === 'paper');
    const models = workQueue.filter(e => e.type === 'model');
    console.log(`[BOOSTER] Work queue: ${workQueue.length} (papers: ${papers.length}, models: ${models.length})`);

    let processed = 0, success = 0, partial = 0, skipped = 0, failed = 0;
    const enrichedUmids = [];

    // ── Phase A: Model README enrichment (HF models only) ──
    const hfModels = models.filter(m => m.canonical_id.startsWith('hf-model--'));
    console.log(`[BOOSTER] HF models: ${hfModels.length}/${models.length} (non-HF skipped)`);
    for (const model of hfModels) {
        processed++;
        if (processed % 100 === 0) console.log(`[BOOSTER] Models: ${processed}/${hfModels.length} | S:${success}`);
        if (Date.now() - startTime > MAX_RUNTIME_MS) break;
        // hf-model--author--name → author/name
        const hfId = model.canonical_id.slice('hf-model--'.length).replace('--', '/');
        const readme = await fetchHfReadme(hfId);
        if (readme) {
            const partition = model.umid.substring(0, 2);
            const key = `enrichment/fulltext/${partition}/${model.umid}.md.zst`;
            const compressed = await zstdCompress(readme);
            await uploadBufferToR2FFI(s3, key, compressed, 'application/zstd');
            enrichedUmids.push(model.umid);
            success++;
        } else { skipped++; }
        await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 500)));
    }
    console.log(`[BOOSTER] Models done: ${success} enriched, ${skipped} skipped`);

    // ── Phase B: Paper enrichment (arXiv waterfall, slow) ──
    const paperStart = { processed: 0, success, skipped, failed };
    for (const paper of papers) {
        processed++;
        paperStart.processed++;
        if (paperStart.processed % 10 === 0) {
            console.log(`[BOOSTER] Papers: ${paperStart.processed}/${papers.length} | S:${success} F:${failed}`);
        }

        if (Date.now() - startTime > MAX_RUNTIME_MS) break;

        const arxivId = extractArxivId(paper.canonical_id);
        if (!arxivId) { skipped++; continue; }

        const jitter = Math.floor(Math.random() * 2000);
        await new Promise(r => setTimeout(r, baseDelay + jitter));

        let htmlResult = await fetchOfficialHtml(arxivId);
        if (htmlResult.type === 'FAILURE') {
            await new Promise(r => setTimeout(r, AR5IV_RETRY_DELAY_MS));
            htmlResult = await fetchOfficialHtml(arxivId);
        }

        if (htmlResult.type !== 'HTML') {
            htmlResult = await fetchAr5ivHtml(arxivId);
            if (htmlResult.type === 'FAILURE') {
                await new Promise(r => setTimeout(r, AR5IV_RETRY_DELAY_MS));
                htmlResult = await fetchAr5ivHtml(arxivId);
            }
        }

        let result;
        if (htmlResult.type === 'HTML' && htmlResult.html) {
            result = extractAndClassifyFFI(htmlResult.html);
            if (result.classification === 'SKIP') {
                htmlResult.type = 'SKIP'; // fallback to S2/PDF due to poor extraction
            } else if (htmlResult.source === 'ar5iv') {
                console.log(`   🌐 [AR5IV] ${arxivId}`);
            }
        }

        if (htmlResult.type !== 'HTML') {
            const s2Text = await fetchS2Fulltext(arxivId, S2_RUNNER_BUDGET);
            if (s2Text && s2Text.length >= 200) {
                result = classifyTextFFI(s2Text);
            } else {
                // PDF fallback (Marker sidecar)
                const pdfText = markerReady ? await fetchArxivPdf(arxivId) : null;
                if (pdfText && pdfText.length >= 200) {
                    result = classifyTextFFI(pdfText);
                    console.log(`   📄 [PDF] ${arxivId}`);
                } else {
                    if (htmlResult.type === 'FAILURE') {
                        console.log(`   ❌ [FAIL] ${arxivId} | HTTP ${htmlResult.status || 'ERR'}`);
                        await handleFailure();
                        failed++;
                    } else {
                        console.log(`   ⏭️ [SKIP] ${arxivId} | No data from any source`);
                        skipped++;
                    }
                    continue;
                }
            }
        }

        if (result.classification === 'SUCCESS' || result.classification === 'PARTIAL') {
            const partition = paper.umid.substring(0, 2);
            const key = `enrichment/fulltext/${partition}/${paper.umid}.md.zst`;
            const compressed = await zstdCompress(result.text);
            await uploadBufferToR2FFI(s3, key, compressed, 'application/zstd');

            if (result.classification === 'SUCCESS') {
                enrichedUmids.push(paper.umid);
                success++;
                console.log(`   ✅ [SUCCESS] ${arxivId}`);
            } else {
                partial++;
                console.log(`   ⚠️ [PARTIAL] ${arxivId}`);
            }
            handleSuccess();
        } else {
            skipped++;
        }
    }

    if (enrichedUmids.length > 0) markEnriched(enrichedUmids);
    shutdownMarkerSidecar();
}

main().catch(err => { console.error('[BOOSTER] Fatal:', err); process.exit(1); });
