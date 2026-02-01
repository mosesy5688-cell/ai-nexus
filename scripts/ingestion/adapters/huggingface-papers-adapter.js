/**
 * HuggingFace Daily Papers Adapter
 * V6.2: Constitution Compliant
 * 
 * Fetches academic papers from HuggingFace Daily Papers API.
 * Source: https://huggingface.co/api/daily_papers
 * 
 * Advantages over PapersWithCode:
 * - No Cloudflare blocking
 * - Native HuggingFace integration
 * - Direct model→paper links
 * 
 * @module ingestion/adapters/huggingface-papers-adapter
 */

import { BaseAdapter } from './base-adapter.js';

const HF_PAPERS_API = 'https://huggingface.co/api/daily_papers';
const HF_API_BASE = 'https://huggingface.co/api';

/**
 * HuggingFace Papers Adapter Implementation
 * V6.2: Alternative to blocked PapersWithCode
 */
export class HuggingFacePapersAdapter extends BaseAdapter {
    constructor() {
        super('hf');
        this.entityTypes = ['paper'];
        this.hfToken = process.env.HF_TOKEN || null;
    }

    /**
     * Get headers with optional HF_TOKEN authentication
     */
    getHeaders() {
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Free2AITools/1.0'
        };
        if (this.hfToken) {
            headers['Authorization'] = `Bearer ${this.hfToken}`;
        }
        return headers;
    }

    /**
     * Rate limiting delay helper
     * @param {number} ms - Milliseconds to delay
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Fetch papers from HuggingFace Daily Papers API
     * @param {Object} options
     * @param {number} options.limit - Maximum papers to fetch (default: 100)
     */
    async fetch(options = {}) {
        const { limit = 100 } = options;

        console.log(`📥 [HuggingFace Papers] Fetching daily papers (limit: ${limit})...`);

        const allPapers = [];

        try {
            // Fetch daily papers
            const response = await fetch(HF_PAPERS_API, {
                headers: this.getHeaders()
            });

            if (!response.ok) {
                throw new Error(`HuggingFace Papers API error: ${response.status}`);
            }

            const papers = await response.json();
            console.log(`📦 [HuggingFace Papers] Got ${papers.length} papers from API`);

            if (this.hfToken) {
                console.log(`🔑 [HuggingFace Papers] Using authenticated requests`);
            }

            // Process papers up to limit
            for (const paper of papers.slice(0, limit)) {
                try {
                    const enrichedPaper = await this.enrichPaper(paper);
                    if (enrichedPaper) {
                        allPapers.push(enrichedPaper);
                    }
                } catch (error) {
                    console.warn(`   ⚠️ Error enriching paper ${paper.id}: ${error.message}`);
                }

                // Rate limiting - Constitution compliant
                if (allPapers.length % 10 === 0) {
                    await this.delay(1000);
                }
            }

        } catch (error) {
            console.error(`   ❌ Fetch error: ${error.message}`);
        }

        console.log(`✅ [HuggingFace Papers] Fetched ${allPapers.length} papers`);
        return allPapers;
    }

    /**
     * Enrich paper with additional metadata
     * @param {Object} paper - Raw paper from API
     */
    async enrichPaper(paper) {
        // Paper already contains most metadata
        return {
            ...paper,
            _source: 'huggingface_papers',
            _fetchedAt: new Date().toISOString()
        };
    }

    /**
     * Normalize raw paper to UnifiedEntity format
     * @param {Object} raw - Raw paper from API
     */
    normalize(raw) {
        const paperId = raw.id || raw.paper?.id;
        const arxivId = raw.paper?.arxivId || this.extractArxivId(paperId);

        const entity = {
            // Identity
            id: this.generateId('unknown', paperId, 'paper'),
            type: 'paper',
            source: 'hf',
            source_url: `https://huggingface.co/papers/${paperId}`,

            // Content
            title: raw.paper?.title || raw.title || paperId,
            description: this.truncate(raw.paper?.summary || '', 500),
            body_content: raw.paper?.summary || '',
            tags: this.extractTags(raw),

            // Metadata
            author: this.extractAuthors(raw),
            license_spdx: 'ArXiv',
            meta_json: this.buildMetaJson(raw),
            created_at: raw.publishedAt || raw.paper?.publishedAt,
            updated_at: raw.updatedAt || raw.paper?.updatedAt,

            // Metrics
            popularity: raw.paper?.upvotes || 0,
            downloads: 0,

            // Paper-specific
            arxiv_id: arxivId,
            arxiv_url: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
            pdf_url: arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : null,

            // Assets
            raw_image_url: raw.paper?.thumbnail || null,

            // Relations
            relations: this.discoverRelations({ arxiv_id: arxivId }),

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Calculate system fields
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculatePaperQuality(entity);

        return entity;
    }

    /**
     * Extract ArXiv ID from paper ID
     */
    extractArxivId(paperId) {
        if (!paperId) return null;

        // Pattern: 2312.00001 or arxiv:2312.00001
        const match = paperId.match(/(\d{4}\.\d{4,5})/);
        return match ? match[1] : null;
    }

    /**
     * Extract authors from paper
     */
    extractAuthors(raw) {
        const authors = raw.paper?.authors || raw.authors || [];
        if (Array.isArray(authors)) {
            return authors.slice(0, 3).map(a => a.name || a).join(', ');
        }
        return 'Unknown';
    }

    /**
     * Extract tags from paper
     */
    extractTags(raw) {
        const tags = ['paper', 'research'];

        // Add HuggingFace-specific tags
        if (raw.paper?.tags) {
            tags.push(...raw.paper.tags);
        }

        // Add category-based tags
        const title = (raw.paper?.title || '').toLowerCase();
        if (title.includes('llm') || title.includes('language model')) {
            tags.push('llm');
        }
        if (title.includes('vision') || title.includes('image')) {
            tags.push('vision');
        }
        if (title.includes('diffusion')) {
            tags.push('diffusion');
        }

        return [...new Set(tags)];
    }

    /**
     * Build metadata JSON
     */
    buildMetaJson(raw) {
        return {
            hf_paper_id: raw.id,
            arxiv_id: raw.paper?.arxivId,
            upvotes: raw.paper?.upvotes || 0,
            comments_count: raw.numComments || 0,
            categories: raw.paper?.categories || [],
            submitted_by: raw.submittedBy?.fullname || null,
            published_at: raw.publishedAt
        };
    }

    /**
     * Calculate paper quality score
     */
    calculatePaperQuality(entity) {
        let score = 0;

        // Content completeness (40 points)
        if (entity.title && entity.title.length > 10) score += 10;
        if (entity.description && entity.description.length > 100) score += 15;
        if (entity.arxiv_id) score += 15;

        // Metrics (30 points)
        const upvotes = entity.popularity || 0;
        score += Math.min(30, Math.log10(upvotes + 1) * 15);

        // Metadata (30 points)
        if (entity.author && entity.author !== 'Unknown') score += 15;
        if (entity.tags.length > 2) score += 15;

        return Math.round(score * 10) / 10;
    }

    /**
     * Asset extraction - papers use thumbnail from API
     */
    extractAssets(raw) {
        const assets = [];

        if (raw.paper?.thumbnail) {
            assets.push({
                type: 'thumbnail',
                url: raw.paper.thumbnail
            });
        }

        return assets;
    }
}

export default HuggingFacePapersAdapter;
