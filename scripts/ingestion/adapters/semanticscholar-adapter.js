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
     * Rate limiting delay helper
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Main Fetch Entry Point
     */
    async fetch(options = {}) {
        const { arxivIds = [], limit = 3000 } = options;

        if (arxivIds.length === 0) {
            console.log(`📥 [S2] No arXiv IDs provided, searching for AI/ML papers...`);
            return await this.searchAIPapers(limit);
        }

        console.log(`📥 [S2] Fetching citations for ${arxivIds.length} papers...`);
        const results = [];

        for (const arxivId of arxivIds.slice(0, limit)) {
            try {
                const paper = await this.fetchPaperByArxiv(arxivId);
                if (paper) results.push(paper);
                await this.delay(3000); // Respect API limit
            } catch (error) {
                console.warn(`   ⚠️ ${arxivId}: ${error.message}`);
            }
        }

        return results;
    }

    /**
     * Search papers by AI topics
     */
    async searchAIPapers(limit = 1000) {
        const TOPICS = ['large language model', 'diffusion model', 'machine learning', 'transformer'];
        const papers = [];

        for (const topic of TOPICS) {
            if (papers.length >= limit) break;
            console.log(`   🔍 Searching: ${topic}...`);
            const results = await this.searchPapers(topic, Math.min(100, limit - papers.length));

            for (const p of results) {
                if (!papers.find(existing => existing.paper_id === p.paper_id)) {
                    papers.push(p);
                }
            }
            await this.delay(3000);
        }
        return papers;
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
        if (!response.ok) return null;

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
