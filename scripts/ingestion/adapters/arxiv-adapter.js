/**
 * ArXiv Papers Adapter -- AI/ML papers via OAI-PMH. CES split: arxiv-parser.js
 * (XML parse), arxiv-oai-client.js (transport+envelope), arxiv-recovery-state.js
 * (active-transport budget). @module ingestion/adapters/arxiv-adapter
 */

import { BaseAdapter } from './base-adapter.js';
import { cleanTitle, extractTags, buildMetaJson, calculatePaperQuality } from './arxiv-parser.js';
import { fetchAr5ivHtml } from './ar5iv-fetcher.js';
import { extractDatasetsFromText } from '../../../src/utils/dataset-extractor.js';
import { ArxivRecoveryState, tokenFingerprint } from './arxiv-recovery-state.js';
import {
    fetchOaiPage,
    buildListRecordsUrl,
    mapOaiRecords,
    classifyOaiError,
    pageFingerprint,
    countRawNewIds,
    parseRetryAfterMs
} from './arxiv-oai-client.js';

// AI/ML relevant ArXiv categories (filter applied during record mapping).
const AI_CATEGORIES = ['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'stat.ML'];

// WO-3-A1: ALL retry/budget/timeout state + non-COMPLETE terminal -> FetchError
// mapping live in the SINGLE arbiter (arxiv-recovery-state.js); adapter owns none.

/** ArXiv Papers Adapter Implementation */
export class ArXivAdapter extends BaseAdapter {
    constructor() {
        super('arxiv');
        this.entityTypes = ['paper'];
    }

    /** Fetch papers from ArXiv API. @param {Object} options (options.limit default 100000) */
    async fetch(options = {}) {
        const { limit = 100000 } = options;

        // V22.8: Fixed 90-day Sliding Window; Global Registry preserves older.
        if (!options.from) {
            const ninetyDaysAgo = new Date();
            ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
            options.from = ninetyDaysAgo.toISOString().split('T')[0];
            console.log(`📡 [ArXiv] No 'from' date provided. Initializing 90-day sliding window: ${options.from}`);
        }

        return this.fetchOAI({ ...options, limit });
    }

    /**
     * Fetch papers via OAI-PMH. WO-3-A1: SAME-TOKEN bounded retry within the single
     * ACTIVE-transport budget; token advances ONLY after a valid page is accepted.
     * All retry/budget/progress state owned by ArxivRecoveryState.
     * @param {Object} [deps] - test seam: { now, sleep } injected into the arbiter.
     */
    async fetchOAI(options = {}, deps = {}) {
        const { limit = 10000, from = null, onBatch } = options;
        console.log(`📥 [ArXiv] OAI-PMH Ingestion: target ${limit} papers...`);

        const allPapers = [];
        const seenIds = new Set();
        // Arbiter backoff defaults to this.delay so tests mocking delay also zero it.
        const state = new ArxivRecoveryState({ sleep: (ms) => this.delay(ms), ...deps });
        let resumptionToken = null; // same-run only; never persisted cross-day.
        let totalFetched = 0;
        let terminal = 'COMPLETE';

        while (totalFetched < limit) {
            // BLOCKER A: ACTIVE-transport budget (only startSpan..endSpan is charged).
            if (state.budgetExhausted()) { terminal = 'TOTAL_BUDGET_EXHAUSTED'; break; }

            state.beginToken(resumptionToken);
            const url = buildListRecordsUrl(resumptionToken, from);
            await this.delay(250); // polite spacing: OUTSIDE span.

            state.startSpan();
            const page = await fetchOaiPage({
                fetchWithTimeout: this.fetchWithTimeout.bind(this),
                url,
                timeoutMs: state.requestTimeoutMs(), // min(120000, remaining budget)
                headers: { 'User-Agent': 'Free2AITools-OAI/1.0' },
            });
            state.endSpan(); // close span: IO done; cycle/progress CPU is not transport.

            // BLOCKER C: ALL retryable HTTP outcomes route through the SINGLE arbiter
            // (canRetryToken + budget-charged wait, Retry-After bounded, then retry SAME
            // token); legacy handleRateLimit() NEVER called. PRECEDENCE (Blocker 2):
            // BUDGET beats page-timeout. (1) budget gone (clipped-timeout abort drove
            // endSpan to ~0) -> TOTAL_BUDGET_EXHAUSTED; (2) attempts exhausted
            // (canRetryToken false) -> PAGE_TIMEOUT/FETCH_ERROR/RATE_LIMIT; (3) attempts
            // remain but retry-wait can't FIT budget -> TOTAL_BUDGET_EXHAUSTED; (4) fit -> retry.
            if (page.kind === 'http') {
                if (state.budgetExhausted()) { terminal = 'TOTAL_BUDGET_EXHAUSTED'; break; }
                const httpRetryable = [403, 429, 502, 503, 504].includes(page.status);
                if (httpRetryable && state.canRetryToken()) {
                    if (await state.executeRetryWait(parseRetryAfterMs(page.response))) {
                        console.warn(`   🔄 [ArXiv] arbiter retry HTTP ${page.status} ${tokenFingerprint(resumptionToken)}`);
                        continue;
                    }
                    terminal = 'TOTAL_BUDGET_EXHAUSTED'; break; // wait refused: budget can't fit
                }
                terminal = (page.status === 429 || page.status === 403) ? 'RATE_LIMIT_EXHAUSTED' : 'FETCH_ERROR';
                console.warn(`   ⚠️ ArXiv OAI HTTP ${page.status} (${tokenFingerprint(resumptionToken)})`);
                break;
            }
            if (page.kind === 'fetch') { // SAME-TOKEN retry within budget; else fail loud.
                if (state.budgetExhausted()) { terminal = 'TOTAL_BUDGET_EXHAUSTED'; break; }
                if (state.canRetryToken()) {
                    if (await state.executeRetryWait()) {
                        console.warn(`   🔄 [ArXiv] same-token retry ${tokenFingerprint(resumptionToken)} (${page.errorKind})`);
                        continue;
                    }
                    terminal = 'TOTAL_BUDGET_EXHAUSTED'; break; // wait refused: budget can't fit
                }
                terminal = page.errorKind === 'abort' ? 'PAGE_TIMEOUT_EXHAUSTED' : 'FETCH_ERROR';
                break;
            }
            if (page.kind === 'parse') {
                if (state.canRetryToken() && await state.executeRetryWait()) continue;
                terminal = 'MALFORMED_XML';
                break;
            }
            if (page.kind === 'oai') {
                terminal = classifyOaiError(page.oaiError, resumptionToken, seenIds.size);
                if (terminal === 'COMPLETE') break; // initial noRecordsMatch -> clean-zero
                console.warn(`   ⛔ [ArXiv] OAI error ${page.oaiError.code} -> ${terminal}`);
                break;
            }

            // kind === 'page'. BLOCKER B: missing <ListRecords> is NEVER a clean end
            // (-> MALFORMED_XML). PRESENT empty ListRecords = clean-zero COMPLETE ONLY
            // for an initial zero-accepted request; a tokened/late empty page = NO_PROGRESS.
            if (!page.listRecordsPresent) {
                terminal = 'MALFORMED_XML';
                console.warn(`   ⛔ [ArXiv] missing <ListRecords> (${resumptionToken ? 'tokened' : 'initial'})`);
                break;
            }
            if (page.records.length === 0 && !page.nextToken) {
                if (!resumptionToken && seenIds.size === 0) break; // clean-zero COMPLETE
                terminal = 'NO_PROGRESS';
                break;
            }

            // BLOCKER D: RAW progress + TOKEN_CYCLE/NO_PROGRESS validated BEFORE seenIds
            // commit + BEFORE enrichBatch (rejected page mutates/enriches NOTHING).
            const progress = state.acceptPage({
                newProductYield: 0, // post-filter product yield; not a progress input
                rawNewIds: countRawNewIds(page.records, seenIds),
                pageFingerprint: pageFingerprint(page.records, page.nextToken),
                nextToken: page.nextToken,
            });
            if (progress) { terminal = progress; break; }

            // Passed validation: commit dedup + enrich OUTSIDE any span (not transport).
            const batch = mapOaiRecords(page.records, seenIds, AI_CATEGORIES);
            await this.enrichBatch(batch);

            totalFetched += batch.length;
            if (onBatch && batch.length > 0) await onBatch(batch);
            else allPapers.push(...batch);
            console.log(`   [ArXiv] OAI Batch: +${batch.length} (unique: ${seenIds.size})`);

            resumptionToken = page.nextToken;
            if (!resumptionToken || totalFetched >= limit) break; // clean end.
            console.log(`   ⏳ [ArXiv] OAI Resumption: Waiting 20s...`); // pacing OUTSIDE span
            await this.delay(20000);
        }

        if (terminal !== 'COMPLETE') {
            // BLOCKER E: fail loud with arbiter-built structured terminal meta (err.meta).
            const err = state.terminalError(terminal, seenIds.size);
            console.error(`❌ [ArXiv] OAI FAILED [${terminal}] kind=${err.kind} — accepted ${seenIds.size} (${JSON.stringify(err.meta)})`);
            throw err;
        }

        console.log(`✅ [ArXiv] OAI Ingestion Complete: ${seenIds.size} unique papers`);
        return onBatch ? [] : allPapers;
    }

    /** Ar5iv enrichment (UNCHANGED; runs OUTSIDE the transport span). */
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

    /** Normalize raw ArXiv paper to UnifiedEntity */
    normalize(raw) {
        const arxivId = raw.arxiv_id;
        const primaryAuthor = raw.authors?.[0] || 'unknown';

        // V27.72: regex-extract datasets from abstract/full-text (whitelist-guarded).
        // LEGAL-RESILIENCE L1 (Papers Abstract-Only): raw.full_html (full third-party
        // body via ar5iv) is a TRANSIENT derivation input ONLY -- mined here then
        // DISCARDED; never persisted into body_content. Stored = abstract + metadata.
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

        // Relation derivation needs the full body: run it against a TRANSIENT clone
        // carrying full text (preserves has_code/arxiv edges) while persisted
        // body_content stays abstract-only. The clone is discarded on return.
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
