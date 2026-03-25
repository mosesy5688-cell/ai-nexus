/**
 * V25.8.4 Density Booster — Asynchronous Paper Enrichment Worker
 *
 * Factory 1.5: Fetches full-text for papers via PDF (primary) + S2 + ar5iv.
 * Core extraction/classification delegated to Rust content-extractor FFI.
 *
 * V25.8.4: PDF-first strategy to bypass ar5iv IP blocking.
 *   Priority: arxiv.org PDF → S2 fullText API → ar5iv HTML (last resort)
 *
 * Usage: node density-booster.js --partition-start=00 --partition-end=0f
 * Budget: 5000 papers / 5 hours per runner (Spec §2.2).
 */

import { initR2Bridge, createR2ClientFFI, fetchAllR2ETagsFFI, uploadBufferToR2FFI } from './lib/r2-bridge.js';
import { getEnrichmentQueue, markEnriched } from './lib/dedup-manager.js';
import { initRustBridge, extractAndClassifyFFI, classifyTextFFI } from './lib/rust-bridge.js';
import { zstdCompress } from './lib/zstd-helper.js';
import { fetchArxivPdf } from './lib/pdf-fetcher.js';

// ── Config ──────────────────────────────────────────────
const AR5IV_BASE = 'https://ar5iv.labs.arxiv.org/html';
const S2_API = 'https://api.semanticscholar.org/graph/v1/paper';
const RATE_LIMIT_MS = 3000;
const FETCH_TIMEOUT_MS = 15000;
const AR5IV_RETRY_DELAY_MS = 8000;
const BUDGET = 5000;
const MAX_RUNTIME_MS = 5 * 60 * 60 * 1000; // 5 hours
const R2_BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';
const BREAKER_THRESHOLD = 5;
const BREAKER_PAUSE_MS = 2 * 60 * 1000; // 2 minutes
const BREAKER_RECOVERY_DELAY = 10000;
const S2_DAILY_QUOTA = 5000;  // Spec §2.1: global account limit
const S2_RUNNER_BUDGET = Math.floor(S2_DAILY_QUOTA / 4); // V25.8.4: 1250 per runner (4 partitions)

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

// ── Fetchers ────────────────────────────────────────────
function extractArxivId(canonicalId) {
    const m = canonicalId.match(/arxiv[_-](?:paper--)?(.+)/i);
    return m ? m[1].replace(/v\d+$/, '') : null;
}

async function fetchAr5iv(arxivId) {
    const url = `${AR5IV_BASE}/${arxivId}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Free2AITools-Booster/1.5', 'Accept': 'text/html' },
            signal: ctrl.signal
        });
        clearTimeout(timer);
        if (res.status === 404) return { type: 'SKIP', html: null };
        if (res.status === 429) return { type: 'FAILURE', html: null };
        if (!res.ok) return { type: 'FAILURE', html: null };
        return { type: 'HTML', html: await res.text() };
    } catch (e) {
        clearTimeout(timer);
        return { type: 'FAILURE', html: null };
    }
}

let s2CallCount = 0, s2QuotaWarned = false;

async function fetchS2Fulltext(arxivId) {
    if (!arxivId) return null;
    if (s2CallCount >= S2_RUNNER_BUDGET) {
        if (!s2QuotaWarned) { console.warn(`[BOOSTER] S2 quota exhausted (${S2_RUNNER_BUDGET}). Remaining papers rely on ar5iv only.`); s2QuotaWarned = true; }
        return null;
    }
    s2CallCount++;
    try {
        const res = await fetch(`${S2_API}/ArXiv:${arxivId}?fields=title,abstract,fullText`, {
            headers: { 'User-Agent': 'Free2AITools-Booster/1.5' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.fullText || null;
    } catch { return null; }
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
    console.log(`[BOOSTER] Pre-sweep: ${enrichedSet.size} UMIDs already enriched`);
    return enrichedSet;
}

// ── Main ────────────────────────────────────────────────
async function main() {
    console.log(`[BOOSTER] V25.8.3 Density Booster starting [${PARTITION_START}..${PARTITION_END}]`);
    const startTime = Date.now();

    const rustStatus = initRustBridge();
    console.log(`[BOOSTER] Rust: ${rustStatus.mode}`);

    initR2Bridge();
    const s3 = createR2ClientFFI();
    if (!s3) { console.error('[BOOSTER] FATAL: R2 credentials missing'); process.exit(1); }

    const alreadyEnriched = await buildAlreadyEnrichedSet(s3);
    const queue = getEnrichmentQueue(PARTITION_START, PARTITION_END, BUDGET);
    const workQueue = queue.filter(p => !alreadyEnriched.has(p.umid));
    console.log(`[BOOSTER] Work queue: ${workQueue.length} papers (${queue.length} total - ${alreadyEnriched.size} done)`);

    let processed = 0, success = 0, partial = 0, skipped = 0, failed = 0;
    const enrichedUmids = [];

    for (const paper of workQueue) {
        if (Date.now() - startTime > MAX_RUNTIME_MS) {
            console.log('[BOOSTER] Budget timeout reached. Exiting gracefully.');
            break;
        }

        const arxivId = extractArxivId(paper.canonical_id);
        if (!arxivId) { skipped++; processed++; continue; }

        await rateLimitPause();

        let result;

        // V25.8.4: Priority chain — PDF → S2 → ar5iv
        // 1. Primary: arxiv.org PDF (bypasses ar5iv IP blocking)
        const pdfText = await fetchArxivPdf(arxivId);
        if (pdfText && pdfText.length >= 200) {
            result = classifyTextFFI(pdfText);
        } else {
            // 2. Fallback: S2 Full-Text API
            const s2Text = await fetchS2Fulltext(arxivId);
            if (s2Text && s2Text.length >= 200) {
                result = classifyTextFFI(s2Text);
            } else {
                // 3. Last resort: ar5iv HTML
                let ar5ivResult = await fetchAr5iv(arxivId);
                if (ar5ivResult.type === 'FAILURE') {
                    await new Promise(r => setTimeout(r, AR5IV_RETRY_DELAY_MS));
                    ar5ivResult = await fetchAr5iv(arxivId);
                }
                if (ar5ivResult.type === 'HTML' && ar5ivResult.html) {
                    result = extractAndClassifyFFI(ar5ivResult.html);
                } else {
                    await handleFailure();
                    failed++;
                    processed++;
                    continue;
                }
            }
        }

        // Upload SUCCESS and PARTIAL to R2
        if (result.classification === 'SUCCESS' || result.classification === 'PARTIAL') {
            const partition = paper.umid.substring(0, 2);
            const key = `enrichment/fulltext/${partition}/${paper.umid}.md.zst`;
            const compressed = await zstdCompress(result.text);
            await uploadBufferToR2FFI(s3, key, compressed, 'application/zstd');

            if (result.classification === 'SUCCESS') {
                enrichedUmids.push(paper.umid);
                success++;
            } else {
                partial++;
            }
            handleSuccess();
        } else {
            skipped++;
        }

        processed++;
        if (processed % 100 === 0) {
            const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
            console.log(`[BOOSTER] Progress: ${processed}/${workQueue.length} | S:${success} P:${partial} K:${skipped} F:${failed} | ${elapsed}min`);
        }
    }

    // Mark enriched UMIDs in dedup ledger
    if (enrichedUmids.length > 0) markEnriched(enrichedUmids);

    const remaining = workQueue.length - processed;
    console.log(`[BOOSTER] Complete: ${processed} processed | SUCCESS:${success} PARTIAL:${partial} SKIP:${skipped} FAIL:${failed}`);
    console.log(`[BOOSTER] Runtime: ${((Date.now() - startTime) / 60000).toFixed(1)} minutes | Remaining: ${remaining}`);

    // Write stats for summary job aggregation
    const statsPath = `output/booster-stats-${PARTITION_START}.json`;
    const fsSync = await import('fs');
    fsSync.default.mkdirSync('output', { recursive: true });
    fsSync.default.writeFileSync(statsPath, JSON.stringify({ success, partial, skipped, failed, remaining }));
}

main().catch(err => { console.error('[BOOSTER] Fatal:', err); process.exit(1); });
