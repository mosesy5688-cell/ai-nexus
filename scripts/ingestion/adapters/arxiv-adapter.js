/**
 * ArXiv Papers Adapter
 * 
 * Fetches AI/ML papers from ArXiv API:
 * - Paper metadata (title, authors, abstract)
 * - ArXiv categories: cs.AI, cs.LG, cs.CL, cs.CV
 * - Links to PDF and source
 * 
 * Split for CES compliance: uses arxiv-parser.js for XML parsing
 * V2.1: Added NSFW filter at fetch level
 * 
 * @module ingestion/adapters/arxiv-adapter
 */

import { parseStringPromise } from 'xml2js';
import { BaseAdapter, NSFW_KEYWORDS, FetchError } from './base-adapter.js';
import {
    parseArxivXML,
    cleanTitle,
    extractTags,
    buildMetaJson,
    calculatePaperQuality
} from './arxiv-parser.js';
import { fetchAr5ivHtml } from './ar5iv-fetcher.js';
import { extractDatasetsFromText } from '../../../src/utils/dataset-extractor.js';

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';
const ARXIV_OAI_BASE = 'https://oaipmh.arxiv.org/oai';

// AI/ML relevant ArXiv categories
const AI_CATEGORIES = ['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'stat.ML'];

// H1 WO-2b (arXiv first-page timeout/retry RECOVERY). WO-1 root-cause: the OAI
// endpoint (oaipmh.arxiv.org) is alive but has intermittent FIRST-request tail
// latency — typically 5-12s, spiking to 65-90s+, independent of window/payload/
// UA. The old 60s AbortController cut that tail into a (post-#2182) LOUD abort
// FetchError that still yielded 0. Recovery = give ONLY the first ListRecords a
// longer budget + a bounded retry so the slow tail can resolve before we give up.
//
// FIRST_PAGE_TIMEOUT_MS=120000: the observed spikes hit 65-90s, so 120s clears
// them with margin. Subsequent resumptionToken pages keep PAGE_TIMEOUT_MS=60000
// (the prior value) — only the cold first request pays the slow-tail penalty.
const FIRST_PAGE_TIMEOUT_MS = 120000;
const PAGE_TIMEOUT_MS = 60000;
// First-page bounded exponential-backoff retry on AbortError/fetch error. 3
// retries with 15s/30s/60s backoff = 105s of backoff sleep; combined with up to
// four 120s request budgets this is generous enough to ride out the spike while
// the budget cap below still bounds a persistently-dead endpoint.
const FIRST_PAGE_MAX_RETRIES = 3;
const FIRST_PAGE_BACKOFF_MS = [15000, 30000, 60000];
// Bounded retry BUDGET: a hard ceiling on cumulative first-page retry WALL-CLOCK
// (backoff sleeps + request budgets), so a dead endpoint can never hang the job
// indefinitely. 105s backoff + 4*120s request budgets ~= 585s worst case; we cap
// at 600s (10 min). Once the budget is exhausted, the retry loop stops and the
// #2182 FetchError is thrown — the run fails LOUD, never green zero-yield.
const FIRST_PAGE_RETRY_BUDGET_MS = 600000;

/**
 * ArXiv Papers Adapter Implementation
 */
export class ArXivAdapter extends BaseAdapter {
    constructor() {
        super('arxiv');
        this.entityTypes = ['paper'];
    }

    /**
     * Fetch papers from ArXiv API
     * @param {Object} options
     * @param {number} options.limit - Number of papers to fetch (default: 100000)
     */
    async fetch(options = {}) {
        const { limit = 100000 } = options;

        // V22.8: Fixed 90-day Sliding Window
        // This ensures the latest papers are always fetched first,
        // while the Global Registry preserves everything older.
        if (!options.from) {
            const ninetyDaysAgo = new Date();
            ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
            options.from = ninetyDaysAgo.toISOString().split('T')[0];
            console.log(`📡 [ArXiv] No 'from' date provided. Initializing 90-day sliding window: ${options.from}`);
        }

        return this.fetchOAI({ ...options, limit });
    }

    /**
     * Fetch papers using OAI-PMH protocol (Incremental & Bulk)
     * V22.4: Replacing legacy Search API polling
     */
    async fetchOAI(options = {}) {
        const {
            limit = 10000,
            from = null, // YYYY-MM-DD
            onBatch
        } = options;

        console.log(`📥 [ArXiv] OAI-PMH Ingestion: target ${limit} papers...`);

        const allPapers = [];
        const seenIds = new Set();
        let resumptionToken = null;
        let totalFetched = 0;
        let consecutiveErrors = 0;
        // H1 WO-2b: first-page recovery state. firstPageRetries counts retries of
        // the cold first ListRecords (resumptionToken === null) only; the budget
        // deadline bounds total first-page retry wall-clock so a dead endpoint
        // cannot hang the job. Subsequent (resumptionToken) pages are untouched.
        let firstPageRetries = 0;
        const firstPageRetryDeadline = Date.now() + FIRST_PAGE_RETRY_BUDGET_MS;
        // H1 (fail loud): records a structured fetch/abort/parse failure so the
        // loop can rethrow instead of laundering an error into a green empty [].
        // A genuinely-empty OAI response (HTTP 200, parseable, no records) does
        // NOT set this — it stays a legitimate success-with-zero result.
        let fetchError = null;

        while (totalFetched < limit) {
            let url = `${ARXIV_OAI_BASE}?verb=ListRecords`;
            if (resumptionToken) {
                url += `&resumptionToken=${encodeURIComponent(resumptionToken)}`;
            } else {
                url += `&metadataPrefix=arXiv&set=cs`;
                if (from) url += `&from=${from}`;
            }

            // V26.13: Per-request sleep to avoid hammering ArXiv servers
            await this.delay(250);

            try {
                // V28: wrap in fetchWithTimeout (was a bare fetch with NO timeout →
                // a hung OAI connection could stall the whole CI job indefinitely).
                // OAI responses can be large; allow 60s. An AbortError lands in the
                // existing catch below, which already retries gracefully (the
                // consecutiveErrors / resumptionToken logic is UNCHANGED).
                // H1 WO-2b: ONLY the cold first ListRecords (resumptionToken === null)
                // gets the longer 120s budget to absorb the OAI slow-tail spike;
                // paginated pages keep the prior 60s. The bump is per-request here,
                // NOT a change to fetchWithTimeout's global default — other adapters
                // are unaffected.
                const requestTimeoutMs = resumptionToken ? PAGE_TIMEOUT_MS : FIRST_PAGE_TIMEOUT_MS;
                const response = await this.fetchWithTimeout(url, {
                    headers: { 'User-Agent': 'Free2AITools-OAI/1.0' }
                }, requestTimeoutMs);

                if (!response.ok) {
                    if (await this.handleRateLimit(response)) { consecutiveErrors = 0; continue; }
                    // V26.13: Retry transient errors (502/504) up to 3 times with backoff
                    if ((response.status === 502 || response.status === 504) && consecutiveErrors < 3) {
                        consecutiveErrors++;
                        const backoff = consecutiveErrors * 15000;
                        console.warn(`   ⚠️ ArXiv OAI ${response.status}, retry ${consecutiveErrors}/3 in ${backoff / 1000}s...`);
                        await this.delay(backoff);
                        continue;
                    }
                    // H1: a non-ok HTTP status that survived the retry ladder is a
                    // real fetch failure, not a legitimate empty result. Record it
                    // so the loop rethrows a structured error instead of returning [].
                    fetchError = new FetchError('arxiv', 'fetch', `OAI HTTP ${response.status}`);
                    console.warn(`   ⚠️ ArXiv OAI failed: ${response.status}`);
                    break;
                }
                consecutiveErrors = 0;

                const xmlText = await response.text();
                const result = await parseStringPromise(xmlText);

                const listRecords = result['OAI-PMH']?.ListRecords?.[0];
                if (!listRecords) {
                    console.warn(`   ⚠️ [ArXiv] No records found in OAI response.`);
                    break;
                }

                const records = listRecords.record || [];
                const batch = [];

                for (const record of records) {
                    const metadata = record.metadata?.[0]?.['arXiv']?.[0];
                    if (!metadata) continue;

                    const arxivId = metadata.id?.[0];
                    if (!arxivId || seenIds.has(arxivId)) continue;

                    // Filter for our target sub-categories if needed
                    // (OAI 'cs' set is broad, we prioritize ML/AI categories in normalization)
                    const categories = (metadata.categories?.[0] || '').split(' ');
                    const isTarget = AI_CATEGORIES.some(cat => categories.includes(cat));

                    if (isTarget) {
                        seenIds.add(arxivId);

                        // Map OAI-arXiv structure to internal paper structure
                        const paper = {
                            arxiv_id: arxivId,
                            title: metadata.title?.[0]?.replace(/\n/g, ' ').trim(),
                            summary: metadata.abstract?.[0]?.replace(/\n/g, ' ').trim(),
                            authors: metadata.authors?.[0]?.author?.map(a => `${a.forenames?.[0] || ''} ${a.keyname?.[0] || ''}`.trim()) || [],
                            published: record.header?.[0]?.datestamp?.[0],
                            updated: record.header?.[0]?.datestamp?.[0],
                            categories: categories,
                            doi: metadata.doi?.[0],
                            license: metadata.license?.[0]
                        };

                        batch.push(paper);
                    }
                }

                // V25.8: Ar5iv full-text enrichment for top papers in batch
                if (batch.length > 0 && process.env.ENABLE_AR5IV !== 'false') {
                    const enrichLimit = Math.min(10, batch.length); // Max 10 per OAI batch
                    for (let ei = 0; ei < enrichLimit; ei++) {
                        try {
                            const fullHtml = await fetchAr5ivHtml(batch[ei].arxiv_id);
                            if (fullHtml) batch[ei].full_html = fullHtml;
                        } catch (err) { console.warn('[ArXiv] ar5iv enrichment failed for ' + (batch[ei]?.arxiv_id || 'unknown') + ': ' + (err?.message || err)); }
                    }
                }

                totalFetched += batch.length;
                if (onBatch && batch.length > 0) {
                    await onBatch(batch);
                } else {
                    allPapers.push(...batch);
                }

                console.log(`   [ArXiv] OAI Batch: +${batch.length} papers (total unique: ${seenIds.size})`);

                resumptionToken = listRecords.resumptionToken?.[0]?._ || listRecords.resumptionToken?.[0];
                if (!resumptionToken || totalFetched >= limit) break;

                // ArXiv OAI: wait 20 seconds before next resumption token request
                // This is stricter than the Search API's 3 seconds
                console.log(`   ⏳ [ArXiv] OAI Resumption: Waiting 20s...`);
                await this.delay(20000);

            } catch (error) {
                console.error(`   ❌ ArXiv OAI error: ${error.message}`);
                // V26.13: If resumptionToken request failed, retry once without token
                if (resumptionToken && consecutiveErrors < 2) {
                    consecutiveErrors++;
                    console.warn(`   🔄 [ArXiv] ResumptionToken may be stale — retrying fresh query in 30s...`);
                    resumptionToken = null;
                    await this.delay(30000);
                    continue;
                }
                // H1 WO-2b: first-page recovery. The cold first ListRecords
                // (resumptionToken === null) is the one exposed to the OAI slow-tail
                // spike. Before #2182's loud FetchError, give it a bounded
                // exponential-backoff retry (15s/30s/60s, max 3) — but only while the
                // total first-page retry budget remains. If the budget is exhausted
                // (or all retries used), we FALL THROUGH to the FetchError below:
                // #2182's fail-loud is preserved, never degraded back to return [].
                if (!resumptionToken && firstPageRetries < FIRST_PAGE_MAX_RETRIES) {
                    const backoffMs = FIRST_PAGE_BACKOFF_MS[firstPageRetries];
                    if (Date.now() + backoffMs <= firstPageRetryDeadline) {
                        firstPageRetries++;
                        console.warn(`   🔄 [ArXiv] First-page fetch failed (${error?.name || 'error'}) — retry ${firstPageRetries}/${FIRST_PAGE_MAX_RETRIES} in ${backoffMs / 1000}s (budget remaining)...`);
                        await this.delay(backoffMs);
                        continue;
                    }
                    console.warn(`   ⛔ [ArXiv] First-page retry budget exhausted — failing loud.`);
                }
                // H1: the retry budget is exhausted. Classify the failure
                // (AbortError from fetchWithTimeout's deadline vs a connection
                // fetch error vs an xml2js parse error) and record it so the
                // loop rethrows a structured error instead of returning a plain
                // [] that the harvester would report as a green zero-yield run.
                const kind = error?.name === 'AbortError'
                    ? 'abort'
                    : (error instanceof TypeError || error?.code) ? 'fetch' : 'parse';
                fetchError = new FetchError('arxiv', kind, error?.message || String(error));
                break;
            }
        }

        // H1 (fail loud): a recorded fetch/abort/parse failure MUST surface as a
        // structured error, never as a green empty result. The completion line
        // below prints ✅ only on the genuine-success path. A legitimate empty
        // OAI response (HTTP 200, parseable, no records) leaves fetchError null
        // and stays success.
        if (fetchError) {
            console.error(`❌ [ArXiv] OAI Ingestion FAILED (${fetchError.kind}): ${fetchError.detail} — ${seenIds.size} papers fetched before failure`);
            throw fetchError;
        }

        console.log(`✅ [ArXiv] OAI Ingestion Complete: ${seenIds.size} unique papers`);
        return onBatch ? [] : allPapers;
    }

    /**
     * Normalize raw ArXiv paper to UnifiedEntity
     */
    normalize(raw) {
        const arxivId = raw.arxiv_id;
        const primaryAuthor = raw.authors?.[0] || 'unknown';

        // V27.72: regex-extract datasets from abstract/full-text (arxiv API has
        // no structured datasets field; whitelist guards against poisoning).
        // LEGAL-RESILIENCE L1 (Papers Abstract-Only): raw.full_html (up to 500KB
        // of full third-party paper body via ar5iv) is a TRANSIENT derivation
        // input ONLY — used here in-process to mine datasets/relations, then
        // DISCARDED. It MUST NOT be persisted into body_content (which packs into
        // the cold .bin via row-builders.buildBundleJson and is served to humans
        // + the public API). Stored/served paper content = abstract + metadata.
        const corpus = `${raw.title || ''} ${raw.summary || ''} ${raw.full_html || ''}`;
        const entity = {
            id: this.generateId('arxiv', arxivId, 'paper'),
            type: 'paper',
            source: 'arxiv',
            source_url: `https://arxiv.org/abs/${arxivId}`,
            title: cleanTitle(raw.title),
            description: this.truncate(raw.summary, 500),
            // Abstract-only. Full paper text is NEVER stored (see note above).
            body_content: raw.summary || '',
            tags: extractTags(raw),
            datasets_used: extractDatasetsFromText(corpus),
            author: primaryAuthor,
            license_spdx: 'arXiv',
            meta_json: buildMetaJson(raw),
            created_at: raw.published,
            updated_at: raw.updated,
            popularity: 0,
            downloads: 0,
            raw_image_url: null,
            relations: [],
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Relation derivation (e.g. has_code -> GitHub repos cited in the paper)
        // still needs the full body. Run it against a TRANSIENT clone carrying the
        // full text, so the has_code/arxiv edges are preserved while the persisted
        // entity.body_content stays abstract-only. The full_html clone is discarded
        // when this function returns — never reaching the packed bundle.
        entity.relations = this.discoverRelations(
            raw.full_html
                ? { ...entity, body_content: `${raw.summary || ''}\n\n${raw.full_html}` }
                : entity
        );
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = calculatePaperQuality(entity);

        return entity;
    }

    extractAssets(raw) {
        return [];
    }
}

export default ArXivAdapter;
