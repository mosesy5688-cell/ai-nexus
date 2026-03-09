/**
 * Semantic Scholar Adapter
 * V16.8.3 Standard Implementation
 * 
 * Fetches academic citation data from Semantic Scholar API.
 * Ensures compatibility with Unified Entity Schema (V2.1).
 * 
 * @module ingestion/adapters/semanticscholar-adapter
 */

import { BaseAdapter } from './base-adapter.js';

const S2_API_BASE = 'https://api.semanticscholar.org/graph/v1';

export class SemanticScholarAdapter extends BaseAdapter {
    constructor() {
        super('semantic_scholar');
        this.entityTypes = ['paper'];
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

        for (const topic of topics) {
            if (seenIds.size >= limit) break;

            let token = null;
            let topicFetched = 0;

            console.log(`   🔍 Searching: ${topic}...`);

            while (topicFetched < limit / topics.length) {
                const fields = 'paperId,externalIds,title,abstract,authors,venue,year,referenceCount,citationCount,openAccessPdf,fieldsOfStudy,s2FieldsOfStudy';
                let url = `${S2_API_BASE}/paper/search/bulk?query=${encodeURIComponent(topic)}&limit=${batchSize}&fields=${fields}`;
                if (token) url += `&token=${token}`;

                try {
                    const response = await fetch(url, { headers: this.getHeaders() });

                    if (!response.ok) {
                        if (await this.handleRateLimit(response)) continue;
                        console.warn(`   ⚠️ S2 Bulk failed: ${response.status}`);
                        break;
                    }

                    const data = await response.json();
                    const papers = data.data || [];
                    if (papers.length === 0) break;

                    const batch = [];
                    for (const paper of papers) {
                        if (paper.paperId && !seenIds.has(paper.paperId)) {
                            // NSFW Filter
                            if (!this.isSafeForWork({ title: paper.title, description: paper.abstract })) continue;

                            // V22.4 Incremental: Check if we already have this paper and if it needs update
                            if (options.registryManager) {
                                const normId = this.generateId('unknown', paper.paperId, 'paper');
                                const existing = options.registryManager.registry?.entities?.find(e => e.id === normId);
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

                } catch (error) {
                    console.error(`   ❌ S2 Bulk error for ${topic}: ${error.message}`);
                    break;
                }
            }
        }

        console.log(`✅ [Semantic Scholar] Ingestion Complete: ${seenIds.size} unique papers`);
        return onBatch ? [] : allPapers;
    }

    /**
     * Normalize raw paper to UnifiedEntity format
     * V16.8.3: Critical fix to avoid duplicate overwriting
     */
    normalize(raw) {
        const paperId = raw.paper_id;
        const arxivId = raw.arxiv_id || this.extractArxivId(paperId);

        const entity = {
            id: this.generateId('unknown', paperId, 'paper'),
            type: 'paper',
            source: 'semantic_scholar',
            source_url: `https://api.semanticscholar.org/${paperId}`,
            title: raw.title || paperId,
            description: this.truncate(raw.description || '', 500),
            body_content: raw.description || '',
            tags: ['paper', 'research', 'academic'],
            author: raw.authors || 'Unknown',
            license_spdx: 'ArXiv',
            meta_json: {
                citation_count: raw.citation_count || 0,
                influential_count: raw.influential_citation_count || 0,
                year: raw.year
            },
            // V24.12: Promoted fields for DB schema expansion
            citation_count: raw.citation_count || 0,

            popularity: raw.citation_count || 0,
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
     */
    async fetchPaperByArxiv(arxivId) {
        const cleanId = arxivId.replace('arxiv:', '').trim();
        const url = `${S2_API_BASE}/paper/arXiv:${cleanId}?fields=title,citationCount,influentialCitationCount,year,authors,abstract`;

        const response = await fetch(url, { headers: { 'User-Agent': 'Free2AITools/1.0' } });
        if (!response.ok) {
            // V22.3: Centralized handleRateLimit (handles 403/429)
            if (await this.handleRateLimit(response)) {
                return await this.fetchPaperByArxiv(arxivId); // Recursive retry
            }
            return null;
        }

        const data = await response.json();
        return {
            paper_id: cleanId,
            title: data.title,
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
     */
    async searchPapers(query, limit = 20) {
        const url = `${S2_API_BASE}/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,citationCount,influentialCitationCount,externalIds,abstract,authors,year`;
        try {
            console.log(`   [S2] Fetching: ${url}`);
            const response = await fetch(url, { headers: { 'User-Agent': 'Free2AITools/1.0' } });
            if (!response.ok) {
                // V22.3: Centralized handleRateLimit (handles 403/429)
                if (await this.handleRateLimit(response)) {
                    return await this.searchPapers(query, limit); // Recursive retry
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
