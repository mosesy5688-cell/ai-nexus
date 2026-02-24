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
                sortOrder,
                offset: options.offset || 0,
                onBatch: options.onBatch // V22.3: Fix missing propagation
            });
        }

        // Default: fetch from combined categories
        const category = 'cs.AI OR cs.LG OR cs.CL OR cs.CV';
        return this.fetchFromCategory({
            category,
            limit,
            sortBy,
            sortOrder,
            offset: options.offset || 0,
            onBatch: options.onBatch // V22.3: Fix missing propagation
        });
    }

    /**
     * Fetch papers by iterating through each AI category (for 50K+ scale)
     */
    async fetchByCategories(options = {}) {
        const {
            limitsPerCategory = 8000,
            sortBy = 'submittedDate',
            sortOrder = 'descending',
            offset = 0,
            onBatch // V17.5: Stream support
        } = options;

        const categories = AI_CATEGORIES;

        console.log(`📥 [ArXiv] Processing ${categories.length} categories...`);

        const allPapers = [];
        const seenIds = new Set();
        let fetchedCount = 0;

        const dedupeAndBatch = async (batch) => {
            const uniqueBatch = [];
            for (const p of batch) {
                if (!seenIds.has(p.arxiv_id)) {
                    seenIds.add(p.arxiv_id);
                    uniqueBatch.push(p);
                }
            }
            if (uniqueBatch.length > 0) {
                fetchedCount += uniqueBatch.length;
                if (onBatch) {
                    await onBatch(uniqueBatch);
                } else {
                    allPapers.push(...uniqueBatch);
                }
            }
        };

        for (const cat of categories) {
            console.log(`   [ArXiv] Category: ${cat}`);
            await this.fetchFromCategory({
                category: cat,
                limit: limitsPerCategory,
                sortBy,
                sortOrder,
                offset, // Pass through
                onBatch: dedupeAndBatch
            });
            console.log(`   [ArXiv] ${cat} complete (total unique so far: ${fetchedCount})`);
        }

        console.log(`✅ [ArXiv] Fetched ${fetchedCount} unique papers total`);
        return onBatch ? [] : allPapers;
    }

    /**
     * Fetch papers from a single ArXiv category
     */
    async fetchFromCategory(options = {}) {
        const {
            category = 'cs.AI',
            limit = 200,
            sortBy = 'submittedDate',
            sortOrder = 'descending',
            offset = 0,
            onBatch
        } = options;

        const batchSize = 50;  // V14.5.2: Reduced batch size for gentler crawling
        const papers = [];
        let backoffSeconds = 20;  // V22.2: Increased initial backoff
        const MAX_BACKOFF = 300;   // V22.2: Increased max backoff to 5 minutes
        let consecutiveErrors = 0;
        const MAX_CONSECUTIVE_ERRORS = 20;  // V22.2: Higher tolerance for flaky API

        for (let i = 0; i < limit; i += batchSize) {
            const currentLimit = Math.min(batchSize, limit - i);
            let start = offset + i; // V18.2.4: Rotate the window
            const query = encodeURIComponent(`cat:${category}`);
            const url = `${ARXIV_API_BASE}?search_query=${query}&start=${start}&max_results=${currentLimit}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'Free2AITools/1.0' }
                });

                if (!response.ok) {
                    // V22.3: Centralized handleRateLimit (handles 403/429)
                    if (await this.handleRateLimit(response)) {
                        start -= batchSize;
                        consecutiveErrors++;
                        continue;
                    }

                    // V14.5: Handle 503/500 with backoff retry
                    if (response.status === 503 || response.status === 500) {
                        const statusType = response.status === 503 ? 'Service Unavailable' : 'Internal Error';
                        console.warn(`   ⚠️ [ArXiv] ${statusType} (${response.status}) on ${category}. Backing off ${backoffSeconds}s...`);
                        await this.delay(backoffSeconds * 1000);
                        backoffSeconds = Math.min(backoffSeconds * 2, MAX_BACKOFF);
                        start -= batchSize;
                        consecutiveErrors++;
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            console.error(`   ❌ [ArXiv] API unhealthy for too long, stopping category ${category}`);
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

                // V19.5 Mode B Phase 2: ArXiv HTML Full-Text Fetching
                console.log(`   📝 Fetching full-text HTML for ${batch.length} papers in batch...`);
                for (const paper of batch) {
                    try {
                        const htmlUrl = `https://arxiv.org/html/${paper.arxiv_id}`;
                        const htmlRes = await fetch(htmlUrl, {
                            headers: { 'User-Agent': 'Free2AITools/1.0' },
                            signal: AbortSignal.timeout(4000)
                        });
                        if (htmlRes.ok) {
                            const htmlText = await htmlRes.text();
                            // Extract just the body/main content to cut down on Head/CSS noise
                            const bodyMatch = htmlText.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
                            const extracted = bodyMatch ? bodyMatch[1] : htmlText;

                            // V22.1 Hardening: Absolute truncation for massive papers (500KB limit)
                            // Some papers have huge SVG/Table data that can crash JSON stringifiers.
                            const MAX_HTML_SIZE = 500000;
                            paper.full_html = (extracted && extracted.length > MAX_HTML_SIZE)
                                ? extracted.substring(0, MAX_HTML_SIZE) + '\n\n[Full-text truncated for memory safety...]'
                                : (extracted || '');
                        }
                    } catch (e) {
                        // Suppress timeout/network errors to keep pipeline moving
                    }
                }

                if (onBatch) {
                    await onBatch(batch);
                } else {
                    papers.push(...batch);
                }

                // ArXiv official: "no more than one request every three seconds"
                // Using 3.5s to be safe and respectful of their infrastructure
                if (start + batchSize < limit) {
                    await this.delay(3500);
                }
            } catch (error) {
                console.warn(`   ⚠️ [ArXiv] Batch error: ${error.message} (Consecutive: ${consecutiveErrors + 1}/${MAX_CONSECUTIVE_ERRORS})`);
                consecutiveErrors++;

                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    console.error(`   ❌ [ArXiv] Final: Too many errors, stopping category ${category}`);
                    break;
                }

                // V22.2: If we are hitting errors, wait significantly longer
                const sleepSeconds = consecutiveErrors > 5 ? 60 : 15;
                console.log(`   ⏳ [ArXiv] Error backup: Sleeping ${sleepSeconds}s...`);
                await this.delay(sleepSeconds * 1000);

                start -= batchSize;
            }
        }

        return onBatch ? [] : papers;
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
            id: this.generateId('arxiv', arxivId, 'paper'),
            type: 'paper',
            source: 'arxiv',
            source_url: `https://arxiv.org/abs/${arxivId}`,
            title: cleanTitle(raw.title),
            description: this.truncate(raw.summary, 500),
            body_content: raw.full_html ? `## Abstract\n${raw.summary}\n\n## Full Paper Semantic Mesh\n${raw.full_html}` : raw.summary || '',
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
