import { initR2Bridge, createR2ClientFFI, fetchAllR2ETagsFFI, uploadBufferToR2FFI } from './lib/r2-bridge.js';
import { getEnrichmentQueue, markEnriched } from './lib/dedup-manager.js';
import { initRustBridge, extractAndClassifyFFI, classifyTextFFI } from './lib/rust-bridge.js';
import { zstdCompress } from './lib/zstd-helper.js';
import { primeSession, extractArxivId, fetchOfficialHtml, fetchAr5ivHtml, fetchS2Fulltext } from './lib/arxiv-fetchers.js';
import { writeBoosterStats } from './lib/booster-stats.js';

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
    console.log(`[BOOSTER] V26.5 Density Booster starting [${PARTITION_START}..${PARTITION_END}]`);
    const startTime = Date.now();

    const rustStatus = initRustBridge();
    await primeSession();

    initR2Bridge();
    const s3 = createR2ClientFFI();
    if (!s3) process.exit(1);

    const alreadyEnriched = await buildAlreadyEnrichedSet(s3);
    const queue = getEnrichmentQueue(PARTITION_START, PARTITION_END, BUDGET);
    const workQueue = queue.filter(p => !alreadyEnriched.has(p.umid));
    const papers = workQueue.filter(e => e.type === 'paper');
    console.log(`[BOOSTER] Work queue: ${workQueue.length} papers`);

    let processed = 0, success = 0, partial = 0, skipped = 0, failed = 0;
    const enrichedUmids = [];

    // V26.5: S2-first waterfall — S2 fulltext (2s) → arXiv HTML (10s). PDF removed.
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

        let result;

        // Layer 1: S2 fulltext (fast, ~2s, API key authenticated)
        const s2Text = await fetchS2Fulltext(arxivId, S2_RUNNER_BUDGET);
        if (s2Text && s2Text.length >= 200) {
            result = classifyTextFFI(s2Text);
            if (result.classification !== 'SKIP') {
                // S2 success — skip HTML entirely
            } else { result = null; }
        }

        // Layer 2: arXiv HTML fallback (slower, ~10s)
        if (!result) {
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
            if (htmlResult.type === 'HTML' && htmlResult.html) {
                result = extractAndClassifyFFI(htmlResult.html);
                if (result.classification === 'SKIP') result = null;
                else if (htmlResult.source === 'ar5iv') console.log(`   [AR5IV] ${arxivId}`);
            }
            if (!result) {
                if (htmlResult.type === 'FAILURE') {
                    console.log(`   [FAIL] ${arxivId} | HTTP ${htmlResult.status || 'ERR'}`);
                    await handleFailure(); failed++;
                } else { skipped++; }
                continue;
            }
        }

        if (result.classification === 'SUCCESS' || result.classification === 'PARTIAL') {
            const partition = paper.umid.substring(0, 2);
            const key = `enrichment/fulltext/${partition}/${paper.umid}.md.zst`;
            const compressed = await zstdCompress(result.text);
            // V25.8.8: Symmetric defensive try-catch — see Phase A rationale above.
            // Additionally, trip the circuit breaker on R2 failure (same as paper-fetch failures).
            try {
                await uploadBufferToR2FFI(s3, key, compressed, 'application/zstd');
            } catch (e) {
                console.warn(`[BOOSTER] R2 PUT failed for ${paper.umid}: ${e?.message || e}`);
                failed++;
                await handleFailure();
                continue;
            }

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
    writeBoosterStats(PARTITION_START, {
        processed, success, partial, skipped, failed,
        remaining: workQueue.length - processed
    });
    // V26.5: Marker PDF removed — S2-first + arXiv HTML fallback only
}

main().catch(err => { console.error('[BOOSTER] Fatal:', err); process.exit(1); });
