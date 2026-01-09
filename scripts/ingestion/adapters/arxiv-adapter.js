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

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';
import {
    parseArxivXML,
    cleanTitle,
    extractTags,
    buildMetaJson,
    calculatePaperQuality
} from './arxiv-parser.js';

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
     */
    async fetch(options = {}) {
        const {
            limit = 200,
            sortBy = 'submittedDate',
            sortOrder = 'descending'
        } = options;

        // For large-scale fetch (10K+), use category-by-category approach
        if (limit >= 10000) {
            return this.fetchByCategories({
                limitsPerCategory: Math.floor(limit / AI_CATEGORIES.length),
                sortBy,
                sortOrder
            });
        }

        // Default: fetch from combined categories
        const category = 'cs.AI OR cs.LG OR cs.CL OR cs.CV';
        return this.fetchFromCategory({ category, limit, sortBy, sortOrder });
    }

    /**
     * Fetch papers by iterating through each AI category (for 50K+ scale)
     */
    async fetchByCategories(options = {}) {
        const {
            limitsPerCategory = 8000,
            sortBy = 'submittedDate',
            sortOrder = 'descending'
        } = options;

        console.log(`📥 [ArXiv] Fetching ~${limitsPerCategory * AI_CATEGORIES.length} papers...`);

        const allPapers = [];
        const seenIds = new Set();

        for (const cat of AI_CATEGORIES) {
            console.log(`   [ArXiv] Category: ${cat}`);
            const papers = await this.fetchFromCategory({
                category: cat,
                limit: limitsPerCategory,
                sortBy,
                sortOrder
            });

            // Deduplicate across categories
            for (const paper of papers) {
                if (!seenIds.has(paper.arxiv_id)) {
                    seenIds.add(paper.arxiv_id);
                    allPapers.push(paper);
                }
            }
            console.log(`   [ArXiv] ${cat}: ${papers.length} papers (total: ${allPapers.length})`);
        }

        console.log(`✅ [ArXiv] Fetched ${allPapers.length} unique papers total`);
        return allPapers;
    }

    /**
     * Fetch papers from a single ArXiv category
     */
    async fetchFromCategory(options = {}) {
        const {
            category = 'cs.AI',
            limit = 200,
            sortBy = 'submittedDate',
            sortOrder = 'descending'
        } = options;

        const batchSize = 50;  // V14.5.2: Reduced batch size for gentler crawling
        const papers = [];
        let backoffSeconds = 15;  // V14.5.2: Increased initial backoff
        const MAX_BACKOFF = 120;   // V14.5.2: Increased max backoff to 2 minutes
        let consecutiveErrors = 0;
        const MAX_CONSECUTIVE_ERRORS = 8;  // V14.5.2: More patience

        for (let start = 0; start < limit; start += batchSize) {
            const currentLimit = Math.min(batchSize, limit - start);
            const query = encodeURIComponent(`cat:${category}`);
            const url = `${ARXIV_API_BASE}?search_query=${query}&start=${start}&max_results=${currentLimit}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'Free2AITools/1.0' }
                });

                if (!response.ok) {
                    // V14.5: Handle rate limit with exponential backoff
                    if (response.status === 429) {
                        console.warn(`   ⚠️ [ArXiv] Rate limited, backing off ${backoffSeconds}s...`);
                        await this.delay(backoffSeconds * 1000);
                        backoffSeconds = Math.min(backoffSeconds * 2, MAX_BACKOFF);
                        start -= batchSize;
                        consecutiveErrors++;
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            console.error(`   ❌ [ArXiv] Too many rate limit errors, stopping category ${category}`);
                            break;
                        }
                        continue;
                    }
                    // V14.5: Handle 503 Service Unavailable with retry
                    if (response.status === 503) {
                        console.warn(`   ⚠️ [ArXiv] Service unavailable (503), retrying in ${backoffSeconds}s...`);
                        await this.delay(backoffSeconds * 1000);
                        backoffSeconds = Math.min(backoffSeconds * 2, MAX_BACKOFF);
                        start -= batchSize;
                        consecutiveErrors++;
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            console.error(`   ❌ [ArXiv] Service unavailable too long, stopping category ${category}`);
                            break;
                        }
                        continue;
                    }
                    throw new Error(`ArXiv API error: ${response.status}`);
                }

                // Success - reset backoff
                backoffSeconds = 15;  // V14.5.2: Reset to initial value
                consecutiveErrors = 0;

                const xmlText = await response.text();
                const batch = parseArxivXML(xmlText);
                papers.push(...batch);

                // ArXiv official: "no more than one request every three seconds"
                // Using 3.5s to be safe and respectful of their infrastructure
                if (start + batchSize < limit) {
                    await this.delay(3500);
                }
            } catch (error) {
                console.warn(`   ⚠️ [ArXiv] Batch error: ${error.message}`);
                consecutiveErrors++;
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    console.error(`   ❌ [ArXiv] Too many errors, stopping category ${category}`);
                    break;
                }
                await this.delay(10000);  // V14.5.2: Longer pause before retry
                start -= batchSize;
            }
        }

        return papers;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Normalize raw ArXiv paper to UnifiedEntity
     */
    normalize(raw) {
        const arxivId = raw.arxiv_id;
        const primaryAuthor = raw.authors?.[0] || 'unknown';

        const entity = {
            id: `arxiv--${arxivId}`,
            type: 'paper',
            source: 'arxiv',
            source_url: `https://arxiv.org/abs/${arxivId}`,
            title: cleanTitle(raw.title),
            description: this.truncate(raw.summary, 500),
            body_content: raw.summary || '',
            tags: extractTags(raw),
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

        entity.relations = this.discoverRelations(entity);
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
