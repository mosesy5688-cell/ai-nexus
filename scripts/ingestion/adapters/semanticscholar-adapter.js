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

// V28: depth cap for self-recursive single-paper/search retries (handleRateLimit's
// circuit breaker also throws at attempt>=6, but this is a hard floor in case a
// future header path keeps returning true without escalating).
const S2_MAX_RETRY_DEPTH = 4;

const S2_API_BASE = 'https://api.semanticscholar.org/graph/v1';
const S2_API_KEY = process.env.S2_API_KEY || '';

export class SemanticScholarAdapter extends BaseAdapter {
    constructor() {
        super('semantic_scholar');
        this.entityTypes = ['paper'];
    }

    getHeaders() {
        const headers = { 'Accept': 'application/json', 'User-Agent': 'Free2AITools-Ingestion/semantic_scholar' };
        if (S2_API_KEY) headers['x-api-key'] = S2_API_KEY;
        return headers;
    }


    /**
     * Main Fetch Entry Point
     */
    async fetch(options = {}) {
        const {
            limit = 1000,
            topics = ['machine learning', 'artificial intelligence', 'nlp', 'computer vision'],
            onBatch
        } = options;

        console.log(`📥 [Semantic Scholar] Bulk Search Ingestion: target ${limit} papers...`);

        const allPapers = [];
        const seenIds = new Set();
        const batchSize = 1000;

        // V28 efficiency: build an id→entity Map ONCE for the incremental skip check.
        // The old `registry.entities.find(...)` ran a linear O(N) scan per paper
        // (O(N×M) over the whole harvest). A Map gives O(1) lookups. Built lazily so
        // a missing/empty registry stays a no-op (null).
        const registryIndex = this.buildRegistryIndex(options.registryManager);

        for (const topic of topics) {
            if (seenIds.size >= limit) break;

            let token = null;
            let topicFetched = 0;
            // V28 hang-fix: loop-scoped 429 attempt counter. A header-less 429 does
            // NOT advance the token (same page re-requested), so the old
            // `handleRateLimit(response)` (legacy flat 60s + continue) spun forever.
            // Pass a numeric attempt → exponential escalation + circuit breaker; reset
            // to 0 after each successful page.
            let attempt = 0;

            console.log(`   🔍 Searching: ${topic}...`);

            try {
                while (topicFetched < limit / topics.length) {
                    const fields = 'paperId,externalIds,title,abstract,authors,venue,year,referenceCount,citationCount,influentialCitationCount,openAccessPdf,fieldsOfStudy,s2FieldsOfStudy,publicationTypes,publicationDate';
                    let url = `${S2_API_BASE}/paper/search/bulk?query=${encodeURIComponent(topic)}&limit=${batchSize}&fields=${fields}`;
                    if (token) url += `&token=${token}`;

                    let response;
                    try {
                        response = await this.fetchWithTimeout(url, { headers: this.getHeaders() });
                    } catch (error) {
                        console.error(`   ❌ S2 Bulk error for ${topic}: ${error.message}`);
                        break;
                    }

                    if (!response.ok) {
                        // V28: numeric attempt → escalation + breaker (breaker throws
                        // RateLimitExceededError, caught below to finish gracefully).
                        if (await this.handleRateLimit(response, attempt++)) continue;
                        console.warn(`   ⚠️ S2 Bulk failed: ${response.status}`);
                        break;
                    }
                    // V28: page fetched OK → reset the 429 escalation counter.
                    attempt = 0;

                    const data = await response.json();
                    const papers = data.data || [];
                    if (papers.length === 0) break;

                    const batch = [];
                    for (const paper of papers) {
                        if (paper.paperId && !seenIds.has(paper.paperId)) {
                            // NSFW Filter
                            if (!this.isSafeForWork({ title: paper.title, description: paper.abstract })) continue;

                            // V22.4 Incremental: Check if we already have this paper and if it needs update
                            if (registryIndex) {
                                const normId = this.generateId('unknown', paper.paperId, 'paper');
                                const existing = registryIndex.get(normId);
                                if (existing) {
                                    // If paper exists and has same citation count, skip
                                    if (existing.meta_json?.citation_count === paper.citationCount) {
                                        seenIds.add(paper.paperId); // Mark as seen to avoid duplicate processing
                                        continue;
                                    }
                                }
                            }

                            seenIds.add(paper.paperId);
                            batch.push(paper);
                        }
                    }

                    topicFetched += batch.length;
                    if (onBatch && batch.length > 0) {
                        await onBatch(batch);
                    } else {
                        allPapers.push(...batch);
                    }

                    console.log(`   [S2] ${topic} Bulk Batch: +${batch.length} papers (total unique: ${seenIds.size})`);

                    token = data.token;
                    if (!token || seenIds.size >= limit) break;

                    await this.delay(5000);
                }
            } catch (error) {
                // V28: breaker tripped (persistent header-less 429) → finish gracefully
                // with what we have rather than spin. Other topics' work is preserved.
                if (error instanceof RateLimitExceededError) {
                    console.warn(`   🛑 [S2] rate-limit breaker tripped on "${topic}" — finishing early with ${seenIds.size} unique papers.`);
                    break;
                }
                throw error;
            }
        }

        console.log(`✅ [Semantic Scholar] Ingestion Complete: ${seenIds.size} unique papers`);
        return onBatch ? [] : allPapers;
    }

    /**
     * V28: Build an id→entity Map from the registry ONCE so the incremental
     * skip check is O(1) per paper instead of an O(N) linear `.find` scan.
     * @param {Object} [registryManager] - options.registryManager (may be undefined)
     * @returns {Map<string, Object>|null} id→entity index, or null if no registry
     */
    buildRegistryIndex(registryManager) {
        const entities = registryManager?.registry?.entities;
        if (!Array.isArray(entities) || entities.length === 0) return null;
        const index = new Map();
        for (const entity of entities) {
            if (entity?.id) index.set(entity.id, entity);
        }
        return index;
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
