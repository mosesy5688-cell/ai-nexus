/**
 * ArXiv Papers Adapter
 * 
 * Fetches AI/ML papers from ArXiv API:
 * - Paper metadata (title, authors, abstract)
 * - ArXiv categories: cs.AI, cs.LG, cs.CL, cs.CV
 * - Links to PDF and source
 * 
 * @module ingestion/adapters/arxiv-adapter
 */

import { BaseAdapter } from './base-adapter.js';

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';

// AI/ML relevant ArXiv categories
const AI_CATEGORIES = ['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'stat.ML'];

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
     * @param {number} options.limit - Number of papers to fetch (default: 200)
     * @param {string} options.category - ArXiv category (default: 'cs.AI')
     * @param {string} options.sortBy - Sort field (submittedDate, relevance)
     */
    async fetch(options = {}) {
        const {
            limit = 200,
            category = 'cs.AI OR cs.LG OR cs.CL OR cs.CV',
            sortBy = 'submittedDate',
            sortOrder = 'descending'
        } = options;

        console.log(`📥 [ArXiv] Fetching top ${limit} papers from ${category}...`);

        // ArXiv API recommends 3 second delay between requests
        // Fetch in smaller batches to avoid 429
        const batchSize = 100;
        const allPapers = [];

        for (let start = 0; start < limit; start += batchSize) {
            const currentLimit = Math.min(batchSize, limit - start);
            const query = encodeURIComponent(`cat:${category}`);
            const url = `${ARXIV_API_BASE}?search_query=${query}&start=${start}&max_results=${currentLimit}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'Free2AITools/1.0' }
                });

                if (!response.ok) {
                    if (response.status === 429) {
                        console.warn(`   ⚠️ [ArXiv] Rate limited, backing off 5 seconds...`);
                        await this.delay(5000);
                        start -= batchSize; // Retry this batch
                        continue;
                    }
                    throw new Error(`ArXiv API error: ${response.status}`);
                }

                const xmlText = await response.text();
                const papers = this.parseArxivXML(xmlText);
                allPapers.push(...papers);

                console.log(`   [ArXiv] Batch ${start / batchSize + 1}: ${papers.length} papers (total: ${allPapers.length})`);

                // ArXiv recommends 3 second delay between requests
                if (start + batchSize < limit) {
                    await this.delay(3000);
                }
            } catch (error) {
                console.warn(`   ⚠️ [ArXiv] Batch error: ${error.message}`);
                break;
            }
        }

        console.log(`✅ [ArXiv] Fetched ${allPapers.length} papers total`);
        return allPapers;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Parse ArXiv XML response
     */
    parseArxivXML(xmlText) {
        const papers = [];

        // Extract entries
        const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
        let match;

        while ((match = entryRegex.exec(xmlText)) !== null) {
            const entryXml = match[1];

            const paper = {
                id: this.extractTag(entryXml, 'id'),
                title: this.extractTag(entryXml, 'title')?.replace(/\s+/g, ' ').trim(),
                summary: this.extractTag(entryXml, 'summary')?.replace(/\s+/g, ' ').trim(),
                published: this.extractTag(entryXml, 'published'),
                updated: this.extractTag(entryXml, 'updated'),
                authors: this.extractAuthors(entryXml),
                categories: this.extractCategories(entryXml),
                links: this.extractLinks(entryXml),
                _fetchedAt: new Date().toISOString()
            };

            // Extract ArXiv ID from URL
            paper.arxiv_id = paper.id?.match(/abs\/(.+)$/)?.[1] || paper.id;

            papers.push(paper);
        }

        return papers;
    }

    extractTag(xml, tagName) {
        const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
        const match = xml.match(regex);
        return match ? match[1].trim() : null;
    }

    extractAuthors(xml) {
        const authors = [];
        const authorRegex = /<author>\s*<name>([^<]+)<\/name>/g;
        let match;
        while ((match = authorRegex.exec(xml)) !== null) {
            authors.push(match[1].trim());
        }
        return authors;
    }

    extractCategories(xml) {
        const categories = [];
        const catRegex = /<category[^>]*term="([^"]+)"/g;
        let match;
        while ((match = catRegex.exec(xml)) !== null) {
            categories.push(match[1]);
        }
        return categories;
    }

    extractLinks(xml) {
        const links = {};

        // PDF link
        const pdfMatch = xml.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/);
        if (pdfMatch) links.pdf = pdfMatch[1];

        // Abstract page
        const absMatch = xml.match(/<link[^>]*type="text\/html"[^>]*href="([^"]+)"/);
        if (absMatch) links.abstract = absMatch[1];

        return links;
    }

    /**
     * Normalize raw ArXiv paper to UnifiedEntity
     */
    normalize(raw) {
        const arxivId = raw.arxiv_id;
        const primaryAuthor = raw.authors?.[0] || 'unknown';

        const entity = {
            // Identity
            id: `arxiv:${arxivId}`,
            type: 'paper',
            source: 'arxiv',
            source_url: `https://arxiv.org/abs/${arxivId}`,

            // Content
            title: this.cleanTitle(raw.title),
            description: this.truncate(raw.summary, 500),
            body_content: raw.summary || '',
            tags: this.extractTags(raw),

            // Metadata
            author: primaryAuthor,
            license_spdx: 'arXiv', // ArXiv has its own license
            meta_json: this.buildMetaJson(raw),
            created_at: raw.published,
            updated_at: raw.updated,

            // Metrics (papers don't have downloads/likes in ArXiv)
            popularity: 0,
            downloads: 0,

            // Assets (papers don't have images)
            raw_image_url: null,

            // Relations
            relations: [],

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Discover relations (models that implement this paper)
        entity.relations = this.discoverRelations(entity);

        // Calculate system fields
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculatePaperQuality(entity);

        return entity;
    }

    /**
     * Extract meaningful images (papers typically don't have cover images)
     */
    extractAssets(raw) {
        // ArXiv papers don't have cover images in the API
        // Could potentially extract from PDF but that's complex
        return [];
    }

    // ============================================================
    // Helper Methods
    // ============================================================

    cleanTitle(title) {
        if (!title) return 'Untitled Paper';
        // Remove extra whitespace and newlines
        return title.replace(/\s+/g, ' ').trim();
    }

    extractTags(raw) {
        const tags = [];

        // Add ArXiv categories as tags
        for (const cat of raw.categories || []) {
            tags.push(`arxiv:${cat}`);
        }

        // Extract keywords from title (common terms)
        const keywords = ['transformer', 'llm', 'diffusion', 'bert', 'gpt',
            'attention', 'neural', 'deep learning', 'gan', 'vae', 'clip',
            'multimodal', 'vision', 'language', 'reinforcement'];

        const titleLower = (raw.title || '').toLowerCase();
        for (const kw of keywords) {
            if (titleLower.includes(kw)) {
                tags.push(kw);
            }
        }

        return [...new Set(tags)];
    }

    buildMetaJson(raw) {
        return {
            arxiv_id: raw.arxiv_id,
            authors: raw.authors || [],
            categories: raw.categories || [],
            primary_category: raw.categories?.[0] || null,
            pdf_url: raw.links?.pdf || null,
            published_date: raw.published,
            updated_date: raw.updated
        };
    }

    calculatePaperQuality(entity) {
        let score = 0;

        // Abstract length
        const abstractLength = entity.body_content?.length || 0;
        if (abstractLength > 200) score += 20;
        if (abstractLength > 500) score += 10;

        // Has multiple authors
        const authorsCount = entity.meta_json?.authors?.length || 0;
        score += Math.min(20, authorsCount * 5);

        // Has categories
        if (entity.tags.length > 0) score += 20;

        // Has PDF link
        if (entity.meta_json?.pdf_url) score += 10;

        // Title quality
        if (entity.title.length > 20) score += 10;

        return Math.min(100, score);
    }
}

export default ArXivAdapter;
