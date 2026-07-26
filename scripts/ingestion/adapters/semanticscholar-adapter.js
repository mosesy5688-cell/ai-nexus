/**
 * Semantic Scholar Adapter
 * V16.8.3 Standard Implementation
 * 
 * Fetches academic citation data from Semantic Scholar API.
 * Ensures compatibility with Unified Entity Schema (V2.1).
 * 
 * @module ingestion/adapters/semanticscholar-adapter
 */

import { BaseAdapter, RateLimitExceededError } from './base-adapter.js';
import { S2RetryState } from './s2-retry-state.js';
import { runBulkSearch, DEFAULT_TOPICS, S2_API_BASE } from './s2-bulk-search.js';

// V28: depth cap for self-recursive single-paper/search retries (handleRateLimit's
// circuit breaker also throws at attempt>=6, but this is a hard floor in case a
// future header path keeps returning true without escalating).
const S2_MAX_RETRY_DEPTH = 4;

const S2_API_KEY = process.env.S2_API_KEY || '';

export class SemanticScholarAdapter extends BaseAdapter {
    constructor() {
        super('semantic_scholar');
        this.entityTypes = ['paper'];
        // TEST SEAM for the bounded recovery ladder ({ now, sleep }). Production
        // leaves it null, so the live path always builds a real clock + real timer;
        // harvest-single.js never sets it. Mirrors the `_adapter` seam that lets the
        // chokepoint's error-vs-empty gate be tested without a network.
        this.retryDeps = null;
    }

    getHeaders() {
        const headers = { 'Accept': 'application/json', 'User-Agent': 'Free2AITools-Ingestion/semantic_scholar' };
        if (S2_API_KEY) headers['x-api-key'] = S2_API_KEY;
        return headers;
    }


    /**
     * Main Fetch Entry Point.
     *
     * 2026-07-26 S2 incident repair (Factory 1/4 run 30189935455): the bulk-search
     * walk moved to s2-bulk-search.js, arbitrated by S2RetryState. The old in-line
     * loop swallowed a transport throw and an HTTP 500 with `console.*` + `break`
     * and then returned an empty array, so harvest-single.js saw a clean zero-yield
     * (`had_adapter_error: false`) and misclassified it `floor_violation: 0 < 300`.
     * Now every non-2xx, request failure, timeout, parse failure and exhausted
     * bounded retry leaves the walk as a FetchError -- the repository's canonical
     * hard-error type (base-adapter.js:48) -- so the source fails loud and
     * INCOMPLETE. The RateLimitExceededError tolerance is preserved unchanged.
     *
     * V28 (PR-D): still no registryManager here (the dead V22.4 skip-unchanged path
     * read a property the SQLite-backed RegistryManager never exposes). Honest:
     * re-fetch every cycle, do not advertise a dead optimization.
     *
     * @param {Object} [options] - limit / topics / onBatch. `_retryDeps` is a TEST
     *   SEAM ({ now, sleep }) for the bounded ladder; production never passes it.
     */
    async fetch(options = {}) {
        const { limit = 1000, topics = [...DEFAULT_TOPICS], onBatch, _retryDeps } = options;
        console.log(`📥 [Semantic Scholar] Bulk Search Ingestion: target ${limit} papers...`);
        // RESET per invocation. The registry (adapters/index.js) holds ONE adapter
        // instance for the whole process, so a stale completion claim or terminalMeta
        // from an earlier fetch() must never leak into a fresh run -- that would let a
        // healthy run inherit "incomplete", or worse, a partial run inherit "complete".
        this.completion = null;
        this.terminalMeta = null;
        const state = new S2RetryState(_retryDeps || this.retryDeps || {});
        this.retryState = state; // evidence handle; never read by the control flow.
        return runBulkSearch({ adapter: this, state, limit, topics, onBatch });
    }

    /**
     * Normalize raw paper to UnifiedEntity format
     * V16.8.3: Critical fix to avoid duplicate overwriting
     */
    normalize(raw) {
        const paperId = raw.paperId || raw.paper_id;
        const arxivId = raw.arxiv_id || raw.externalIds?.ArXiv || this.extractArxivId(paperId);

        const tldrText = raw.tldr?.text || '';
        const abstract = raw.abstract || raw.description || '';
        const citations = raw.citationCount || raw.citation_count || 0;
        const influentialCitations = raw.influentialCitationCount || raw.influential_citation_count || 0;
        const entity = {
            id: this.generateId('unknown', paperId, 'paper'),
            type: 'paper',
            source: 'semantic_scholar',
            source_url: `https://api.semanticscholar.org/${paperId}`,
            // V28 honest-contract: never present the opaque S2 paperId AS a title.
            // A missing title is null (surface decides display), not an ID-as-title.
            title: raw.title || null,
            description: this.truncate(tldrText || abstract, 500),
            body_content: tldrText || abstract,
            tags: ['paper', 'research', 'academic'],
            author: raw.authors || 'Unknown',
            license_spdx: 'ArXiv',
            meta_json: {
                citation_count: citations,
                influential_count: influentialCitations,
                year: raw.year,
                venue: raw.venue || '',
                publication_types: raw.publicationTypes || [],
                publication_date: raw.publicationDate || raw.publication_date || ''
            },
            citation_count: citations,
            popularity: citations,
            downloads: 0,
            arxiv_id: arxivId,
            arxiv_url: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
            compliance_status: 'approved',
            quality_score: 50,
            content_hash: null
        };

        entity.content_hash = this.generateContentHash(entity);
        entity.quality_score = this.calculateQualityScore(entity);
        return entity;
    }

    /**
     * Fetch single paper by ArXiv ID
     * V28: bounded self-recursion. `depth` is threaded into handleRateLimit (→
     * escalation + breaker) and recursion stops at S2_MAX_RETRY_DEPTH so a
     * persistent header-less 429 can no longer recurse forever. fetch wrapped in
     * fetchWithTimeout so a hanging request aborts.
     */
    async fetchPaperByArxiv(arxivId, depth = 0) {
        const cleanId = arxivId.replace('arxiv:', '').trim();
        const url = `${S2_API_BASE}/paper/arXiv:${cleanId}?fields=title,citationCount,influentialCitationCount,year,authors,abstract`;

        let response;
        try {
            response = await this.fetchWithTimeout(url, { headers: this.getHeaders() });
        } catch (error) {
            console.warn(`   [S2] fetchPaperByArxiv error for ${cleanId}: ${error.message}`);
            return null;
        }
        if (!response.ok) {
            if (depth >= S2_MAX_RETRY_DEPTH) return null;
            try {
                if (await this.handleRateLimit(response, depth)) {
                    return await this.fetchPaperByArxiv(arxivId, depth + 1);
                }
            } catch (error) {
                // Breaker (RateLimitExceededError) — give up on this single paper.
                if (error instanceof RateLimitExceededError) return null;
                throw error;
            }
            return null;
        }

        const data = await response.json();
        return {
            paper_id: cleanId,
            title: data.title,
            abstract: data.abstract || '',
            description: data.abstract || '',
            citation_count: data.citationCount || 0,
            influential_citation_count: data.influentialCitationCount || 0,
            authors: data.authors?.map(a => a.name).join(', ') || 'Unknown',
            year: data.year,
            source: 'semantic_scholar'
        };
    }

    /**
     * Generic Search
     * V28: bounded self-recursion (depth → handleRateLimit escalation + breaker,
     * stops at S2_MAX_RETRY_DEPTH) so a persistent header-less 429 cannot recurse
     * forever. fetch wrapped in fetchWithTimeout so a hanging request aborts.
     */
    async searchPapers(query, limit = 20, depth = 0) {
        const url = `${S2_API_BASE}/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,citationCount,influentialCitationCount,externalIds,abstract,authors,year`;
        try {
            console.log(`   [S2] Fetching: ${url}`);
            const response = await this.fetchWithTimeout(url, { headers: this.getHeaders() });
            if (!response.ok) {
                // V22.3: Centralized handleRateLimit (handles 403/429)
                if (depth < S2_MAX_RETRY_DEPTH && await this.handleRateLimit(response, depth)) {
                    return await this.searchPapers(query, limit, depth + 1); // bounded recursive retry
                }
                console.warn(`   [S2] API Error: ${response.status} ${response.statusText}`);
                return [];
            }
            const data = await response.json();
            console.log(`   [S2] Found ${data.data?.length || 0} results`);
            return (data.data || []).map(p => ({
                paper_id: p.externalIds?.ArXiv || p.paperId,
                title: p.title,
                description: p.abstract || '',
                citation_count: p.citationCount || 0,
                influential_citation_count: p.influentialCitationCount || 0,
                authors: p.authors?.map(a => a.name).join(', ') || 'Unknown',
                year: p.year,
                source: 'semantic_scholar'
            }));
        } catch (e) {
            return [];
        }
    }

    extractArxivId(id) {
        const match = (id || '').match(/(\d{4}\.\d{4,5})/);
        return match ? match[1] : null;
    }

    extractAssets(raw) { return []; }
}

export default SemanticScholarAdapter;
