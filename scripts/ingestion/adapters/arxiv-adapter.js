/**
 * ArXiv Papers Adapter — fetches AI/ML papers via OAI-PMH (title/authors/
 * abstract/categories/links). CES split: arxiv-parser.js (XML field parse),
 * arxiv-oai-client.js (transport + envelope), arxiv-recovery-state.js (budget).
 * @module ingestion/adapters/arxiv-adapter
 */

import { BaseAdapter, FetchError } from './base-adapter.js';
import {
    cleanTitle,
    extractTags,
    buildMetaJson,
    calculatePaperQuality
} from './arxiv-parser.js';
import { fetchAr5ivHtml } from './ar5iv-fetcher.js';
import { extractDatasetsFromText } from '../../../src/utils/dataset-extractor.js';
import { ArxivRecoveryState, tokenFingerprint } from './arxiv-recovery-state.js';
import {
    fetchOaiPage,
    buildListRecordsUrl,
    mapOaiRecords,
    classifyOaiError
} from './arxiv-oai-client.js';

// AI/ML relevant ArXiv categories (filter applied during record mapping).
const AI_CATEGORIES = ['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'stat.ML'];

// WO-3-A1 (Transport Recovery Core): all retry/budget/timeout state lives in the
// SINGLE arbiter (arxiv-recovery-state.js); the adapter owns no retry budget.
// Terminal taxonomy (all non-COMPLETE fail loud, never a green healthy-partial,
// never a window-origin restart): COMPLETE, BAD_RESUMPTION_TOKEN, OAI_ERROR,
// PAGE_TIMEOUT_EXHAUSTED, TOTAL_BUDGET_EXHAUSTED, MALFORMED_XML, NO_PROGRESS,
// TOKEN_CYCLE, FETCH_ERROR. Terminal -> FetchError kind (preserves H1 taxonomy):
const TERMINAL_KIND = {
    PAGE_TIMEOUT_EXHAUSTED: 'abort',
    TOTAL_BUDGET_EXHAUSTED: 'abort',
    FETCH_ERROR: 'fetch',
    OAI_ERROR: 'fetch',
    BAD_RESUMPTION_TOKEN: 'fetch',
    NO_PROGRESS: 'fetch',
    TOKEN_CYCLE: 'fetch',
    MALFORMED_XML: 'parse',
};

/**
 * ArXiv Papers Adapter Implementation
 */
export class ArXivAdapter extends BaseAdapter {
    constructor() {
        super('arxiv');
        this.entityTypes = ['paper'];
    }

    /**
     * Fetch papers from ArXiv API.
     * @param {Object} options
     * @param {number} options.limit - Number of papers to fetch (default: 100000)
     */
    async fetch(options = {}) {
        const { limit = 100000 } = options;

        // V22.8: Fixed 90-day Sliding Window. Latest papers fetched first; the
        // Global Registry preserves everything older.
        if (!options.from) {
            const ninetyDaysAgo = new Date();
            ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
            options.from = ninetyDaysAgo.toISOString().split('T')[0];
            console.log(`📡 [ArXiv] No 'from' date provided. Initializing 90-day sliding window: ${options.from}`);
        }

        return this.fetchOAI({ ...options, limit });
    }

    /**
     * Fetch papers using OAI-PMH protocol. WO-3-A1: SAME-TOKEN bounded retry
     * replaces the old window-origin restart; a failing resumption page RETAINS
     * its exact token and retries within the single transport budget; the token
     * advances ONLY after a complete valid page is accepted. Retry/budget/progress
     * state is owned by the single arbiter (ArxivRecoveryState).
     * @param {Object} [deps] - test seam: { now, sleep } injected into the arbiter.
     */
    async fetchOAI(options = {}, deps = {}) {
        const { limit = 10000, from = null, onBatch } = options;
        console.log(`📥 [ArXiv] OAI-PMH Ingestion: target ${limit} papers...`);

        const allPapers = [];
        const seenIds = new Set();
        // Default the arbiter's backoff sleep to this.delay so existing tests that
        // mock adapter.delay also zero the retry backoff (no real sleeping). An
        // explicit deps.sleep (e.g. a fake clock) still overrides.
        const state = new ArxivRecoveryState({ sleep: (ms) => this.delay(ms), ...deps });
        let resumptionToken = null; // same-run only; never persisted cross-day.
        let totalFetched = 0;
        let terminal = 'COMPLETE';

        while (totalFetched < limit) {
            if (state.budgetExhausted()) { terminal = 'TOTAL_BUDGET_EXHAUSTED'; break; }

            state.beginToken(resumptionToken);
            const url = buildListRecordsUrl(resumptionToken, from);
            await this.delay(250); // polite per-request spacing (zeroable in tests)

            const page = await fetchOaiPage({
                fetchWithTimeout: this.fetchWithTimeout.bind(this),
                url,
                timeoutMs: state.requestTimeoutMs(),
                headers: { 'User-Agent': 'Free2AITools-OAI/1.0' },
            });

            // Non-page outcomes (page atomicity: nothing accepted until 'page').
            if (page.kind === 'http') {
                if (await this.handleRateLimit(page.response)) continue;
                if ((page.status === 502 || page.status === 504) && state.canRetryToken()) {
                    if (await state.backoffForRetry()) continue;
                }
                terminal = 'FETCH_ERROR';
                console.warn(`   ⚠️ ArXiv OAI HTTP ${page.status} (${tokenFingerprint(resumptionToken)})`);
                break;
            }
            if (page.kind === 'fetch') {
                // SAME-TOKEN retry: retain the exact token, retry within budget.
                if (state.canRetryToken() && await state.backoffForRetry()) {
                    console.warn(`   🔄 [ArXiv] same-token retry ${tokenFingerprint(resumptionToken)} (${page.errorKind})`);
                    continue;
                }
                terminal = page.errorKind === 'abort' ? 'PAGE_TIMEOUT_EXHAUSTED' : 'FETCH_ERROR';
                break;
            }
            if (page.kind === 'parse') {
                if (state.canRetryToken() && await state.backoffForRetry()) continue;
                terminal = 'MALFORMED_XML';
                break;
            }
            if (page.kind === 'oai') {
                terminal = classifyOaiError(page.oaiError, resumptionToken, seenIds.size);
                if (terminal === 'COMPLETE') break; // initial noRecordsMatch -> clean-zero
                console.warn(`   ⛔ [ArXiv] OAI error ${page.oaiError.code} -> ${terminal}`);
                break;
            }

            // kind === 'page': accept atomically, THEN advance token.
            const batch = mapOaiRecords(page.records, seenIds, AI_CATEGORIES);
            await this.enrichBatch(batch);
            const progress = state.acceptPage(batch.length, page.nextToken);
            if (progress) { terminal = progress; break; }

            totalFetched += batch.length;
            if (onBatch && batch.length > 0) await onBatch(batch);
            else allPapers.push(...batch);
            console.log(`   [ArXiv] OAI Batch: +${batch.length} (unique: ${seenIds.size})`);

            resumptionToken = page.nextToken;
            if (!resumptionToken || totalFetched >= limit) break; // clean end.
            console.log(`   ⏳ [ArXiv] OAI Resumption: Waiting 20s...`);
            await this.delay(20000);
        }

        if (terminal !== 'COMPLETE') {
            const kind = TERMINAL_KIND[terminal] || 'fetch';
            const snap = state.snapshot(terminal);
            console.error(`❌ [ArXiv] OAI FAILED [${terminal}] kind=${kind} — accepted ${seenIds.size} before failure (${JSON.stringify(snap)})`);
            throw new FetchError('arxiv', kind, `${terminal}: ${seenIds.size} accepted before failure`);
        }

        console.log(`✅ [ArXiv] OAI Ingestion Complete: ${seenIds.size} unique papers`);
        return onBatch ? [] : allPapers;
    }

    /** Ar5iv full-text enrichment (UNCHANGED; PR-A1 does not touch enrichment). */
    async enrichBatch(batch) {
        if (batch.length === 0 || process.env.ENABLE_AR5IV === 'false') return;
        const enrichLimit = Math.min(10, batch.length);
        for (let ei = 0; ei < enrichLimit; ei++) {
            try {
                const fullHtml = await fetchAr5ivHtml(batch[ei].arxiv_id);
                if (fullHtml) batch[ei].full_html = fullHtml;
            } catch (err) {
                console.warn('[ArXiv] ar5iv enrichment failed for ' + (batch[ei]?.arxiv_id || 'unknown') + ': ' + (err?.message || err));
            }
        }
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
