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

import { parseStringPromise } from 'xml2js';
import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';
import {
    parseArxivXML,
    cleanTitle,
    extractTags,
    buildMetaJson,
    calculatePaperQuality
} from './arxiv-parser.js';
import { fetchAr5ivHtml } from './ar5iv-fetcher.js';

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';
const ARXIV_OAI_BASE = 'https://oaipmh.arxiv.org/oai';

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
     * @param {number} options.limit - Number of papers to fetch (default: 100000)
     */
    async fetch(options = {}) {
        const { limit = 100000 } = options;

        // V22.8: Fixed 90-day Sliding Window
        // This ensures the latest papers are always fetched first,
        // while the Global Registry preserves everything older.
        if (!options.from) {
            const ninetyDaysAgo = new Date();
            ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
            options.from = ninetyDaysAgo.toISOString().split('T')[0];
            console.log(`📡 [ArXiv] No 'from' date provided. Initializing 90-day sliding window: ${options.from}`);
        }

        return this.fetchOAI({ ...options, limit });
    }

    /**
     * Fetch papers using OAI-PMH protocol (Incremental & Bulk)
     * V22.4: Replacing legacy Search API polling
     */
    async fetchOAI(options = {}) {
        const {
            limit = 10000,
            from = null, // YYYY-MM-DD
            onBatch
        } = options;

        console.log(`📥 [ArXiv] OAI-PMH Ingestion: target ${limit} papers...`);

        const allPapers = [];
        const seenIds = new Set();
        let resumptionToken = null;
        let totalFetched = 0;
        let consecutiveErrors = 0;

        while (totalFetched < limit) {
            let url = `${ARXIV_OAI_BASE}?verb=ListRecords`;
            if (resumptionToken) {
                url += `&resumptionToken=${encodeURIComponent(resumptionToken)}`;
            } else {
                url += `&metadataPrefix=arXiv&set=cs`;
                if (from) url += `&from=${from}`;
            }

            // V26.13: Per-request sleep to avoid hammering ArXiv servers
            await this.delay(250);

            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'Free2AITools-OAI/1.0' }
                });

                if (!response.ok) {
                    if (await this.handleRateLimit(response)) { consecutiveErrors = 0; continue; }
                    // V26.13: Retry transient errors (502/504) up to 3 times with backoff
                    if ((response.status === 502 || response.status === 504) && consecutiveErrors < 3) {
                        consecutiveErrors++;
                        const backoff = consecutiveErrors * 15000;
                        console.warn(`   ⚠️ ArXiv OAI ${response.status}, retry ${consecutiveErrors}/3 in ${backoff / 1000}s...`);
                        await this.delay(backoff);
                        continue;
                    }
                    console.warn(`   ⚠️ ArXiv OAI failed: ${response.status}`);
                    break;
                }
                consecutiveErrors = 0;

                const xmlText = await response.text();
                const result = await parseStringPromise(xmlText);

                const listRecords = result['OAI-PMH']?.ListRecords?.[0];
                if (!listRecords) {
                    console.warn(`   ⚠️ [ArXiv] No records found in OAI response.`);
                    break;
                }

                const records = listRecords.record || [];
                const batch = [];

                for (const record of records) {
                    const metadata = record.metadata?.[0]?.['arXiv']?.[0];
                    if (!metadata) continue;

                    const arxivId = metadata.id?.[0];
                    if (!arxivId || seenIds.has(arxivId)) continue;

                    // Filter for our target sub-categories if needed
                    // (OAI 'cs' set is broad, we prioritize ML/AI categories in normalization)
                    const categories = (metadata.categories?.[0] || '').split(' ');
                    const isTarget = AI_CATEGORIES.some(cat => categories.includes(cat));

                    if (isTarget) {
                        seenIds.add(arxivId);

                        // Map OAI-arXiv structure to internal paper structure
                        const paper = {
                            arxiv_id: arxivId,
                            title: metadata.title?.[0]?.replace(/\n/g, ' ').trim(),
                            summary: metadata.abstract?.[0]?.replace(/\n/g, ' ').trim(),
                            authors: metadata.authors?.[0]?.author?.map(a => `${a.forenames?.[0] || ''} ${a.keyname?.[0] || ''}`.trim()) || [],
                            published: record.header?.[0]?.datestamp?.[0],
                            updated: record.header?.[0]?.datestamp?.[0],
                            categories: categories,
                            doi: metadata.doi?.[0],
                            license: metadata.license?.[0]
                        };

                        batch.push(paper);
                    }
                }

                // V25.8: Ar5iv full-text enrichment for top papers in batch
                if (batch.length > 0 && process.env.ENABLE_AR5IV !== 'false') {
                    const enrichLimit = Math.min(10, batch.length); // Max 10 per OAI batch
                    for (let ei = 0; ei < enrichLimit; ei++) {
                        try {
                            const fullHtml = await fetchAr5ivHtml(batch[ei].arxiv_id);
                            if (fullHtml) batch[ei].full_html = fullHtml;
                        } catch { /* Non-critical: fallback to abstract */ }
                    }
                }

                totalFetched += batch.length;
                if (onBatch && batch.length > 0) {
                    await onBatch(batch);
                } else {
                    allPapers.push(...batch);
                }

                console.log(`   [ArXiv] OAI Batch: +${batch.length} papers (total unique: ${seenIds.size})`);

                resumptionToken = listRecords.resumptionToken?.[0]?._ || listRecords.resumptionToken?.[0];
                if (!resumptionToken || totalFetched >= limit) break;

                // ArXiv OAI: wait 20 seconds before next resumption token request
                // This is stricter than the Search API's 3 seconds
                console.log(`   ⏳ [ArXiv] OAI Resumption: Waiting 20s...`);
                await this.delay(20000);

            } catch (error) {
                console.error(`   ❌ ArXiv OAI error: ${error.message}`);
                // V26.13: If resumptionToken request failed, retry once without token
                if (resumptionToken && consecutiveErrors < 2) {
                    consecutiveErrors++;
                    console.warn(`   🔄 [ArXiv] ResumptionToken may be stale — retrying fresh query in 30s...`);
                    resumptionToken = null;
                    await this.delay(30000);
                    continue;
                }
                break;
            }
        }

        console.log(`✅ [ArXiv] OAI Ingestion Complete: ${seenIds.size} unique papers`);
        return onBatch ? [] : allPapers;
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
            body_content: raw.full_html
                ? `## Abstract\n${raw.summary}\n\n## Full Paper Content\n${raw.full_html}`
                : raw.summary || '',
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
