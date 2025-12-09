/**
 * Papers With Code Adapter
 * 
 * Fetches AI research data from Papers With Code API:
 * - Papers linked to implementations
 * - SOTA benchmarks
 * - Model-paper associations
 * 
 * @module ingestion/adapters/pwc-adapter
 */

import { BaseAdapter } from './base-adapter.js';

const PWC_API_BASE = 'https://paperswithcode.com/api/v1';

/**
 * Papers With Code Adapter Implementation
 */
export class PapersWithCodeAdapter extends BaseAdapter {
    constructor() {
        super('paperswithcode');
        this.entityTypes = ['paper'];
    }

    /**
     * Fetch papers from Papers With Code API
     * @param {Object} options
     * @param {number} options.limit - Number of papers to fetch (default: 300)
     * @param {string} options.ordering - Sort field (default: '-github_stars')
     */
    async fetch(options = {}) {
        const {
            limit = 300,
            ordering = '-github_stars',
            page = 1
        } = options;

        console.log(`📥 [PWC] Fetching top ${limit} papers by ${ordering}...`);

        const papers = [];
        const perPage = 50;
        const totalPages = Math.ceil(limit / perPage);

        for (let p = 1; p <= totalPages; p++) {
            const url = `${PWC_API_BASE}/papers/?page=${p}&items_per_page=${perPage}&ordering=${ordering}`;

            try {
                const response = await fetch(url);

                if (!response.ok) {
                    console.warn(`   ⚠️ PWC API page ${p} failed: ${response.status}`);
                    continue;
                }

                const data = await response.json();

                if (data.results && Array.isArray(data.results)) {
                    papers.push(...data.results);
                    console.log(`   Page ${p}: got ${data.results.length} papers`);
                }

                // Respect rate limits
                await this.delay(200);

                if (papers.length >= limit) break;
            } catch (error) {
                console.warn(`   ⚠️ Error fetching page ${p}: ${error.message}`);
            }
        }

        console.log(`✅ [PWC] Fetched ${papers.length} papers with code`);
        return papers.slice(0, limit);
    }

    /**
     * Fetch paper implementations (repos)
     */
    async fetchImplementations(paperId) {
        try {
            const url = `${PWC_API_BASE}/papers/${paperId}/repositories/`;
            const response = await fetch(url);

            if (!response.ok) return [];

            const data = await response.json();
            return data.results || [];
        } catch (error) {
            return [];
        }
    }

    /**
     * Normalize raw PWC paper to UnifiedEntity
     */
    normalize(raw) {
        const paperId = raw.id || raw.paper;
        const title = raw.title || 'Unknown Paper';

        const entity = {
            // Identity
            id: `pwc:${paperId}`,
            type: 'paper',
            source: 'paperswithcode',
            source_url: raw.paper_url || `https://paperswithcode.com/paper/${paperId}`,

            // Content
            title: title,
            description: this.truncate(raw.abstract || '', 500),
            body_content: raw.abstract || '',
            tags: this.extractTags(raw),

            // Metadata
            author: this.extractFirstAuthor(raw.authors),
            license_spdx: null, // PWC doesn't provide license
            meta_json: this.buildMetaJson(raw),
            created_at: raw.published || raw.date,
            updated_at: null,

            // Metrics
            popularity: raw.repository_count || 0,
            downloads: 0,
            github_stars: this.extractGitHubStars(raw),

            // Assets
            raw_image_url: null,

            // Relations (link to implementations)
            relations: this.buildRelations(raw),

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
     * Extract assets (PWC doesn't provide images via API)
     */
    extractAssets(raw) {
        return [];
    }

    // ============================================================
    // Helper Methods
    // ============================================================

    extractFirstAuthor(authors) {
        if (typeof authors === 'string') {
            return authors.split(',')[0].trim();
        }
        if (Array.isArray(authors) && authors.length > 0) {
            if (typeof authors[0] === 'object') {
                return authors[0].name || 'unknown';
            }
            return authors[0];
        }
        return 'unknown';
    }

    extractGitHubStars(raw) {
        // Try to get stars from linked repositories
        if (raw.repositories && Array.isArray(raw.repositories)) {
            const totalStars = raw.repositories.reduce((sum, repo) => {
                return sum + (repo.stars || 0);
            }, 0);
            return totalStars;
        }
        return raw.github_stars || 0;
    }

    extractTags(raw) {
        const tags = [];

        // Add tasks as tags
        if (raw.tasks && Array.isArray(raw.tasks)) {
            for (const task of raw.tasks) {
                const taskName = typeof task === 'object' ? task.task : task;
                if (taskName) {
                    tags.push(taskName.toLowerCase().replace(/\s+/g, '-'));
                }
            }
        }

        // Add methods as tags
        if (raw.methods && Array.isArray(raw.methods)) {
            for (const method of raw.methods) {
                const methodName = typeof method === 'object' ? method.name : method;
                if (methodName) {
                    tags.push(methodName.toLowerCase());
                }
            }
        }

        // Add conference if available
        if (raw.conference) {
            tags.push(`conference:${raw.conference}`);
        }

        return [...new Set(tags)];
    }

    buildMetaJson(raw) {
        return {
            pwc_id: raw.id,
            arxiv_id: raw.arxiv_id || null,
            conference: raw.conference || null,
            tasks: raw.tasks || [],
            methods: raw.methods || [],
            repository_count: raw.repository_count || 0,
            is_official: raw.is_official || false,
            paper_url: raw.paper_url || null,
            pdf_url: raw.url_pdf || null
        };
    }

    buildRelations(raw) {
        const relations = [];

        // Link to ArXiv paper if available
        if (raw.arxiv_id) {
            relations.push({
                type: 'same_as',
                target_id: `arxiv:${raw.arxiv_id}`,
                source_url: `https://arxiv.org/abs/${raw.arxiv_id}`
            });
        }

        // Link to implementations
        if (raw.repositories && Array.isArray(raw.repositories)) {
            for (const repo of raw.repositories) {
                if (repo.url) {
                    const match = repo.url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
                    if (match) {
                        relations.push({
                            type: 'has_implementation',
                            target_id: `github:${match[1]}:${match[2]}`,
                            source_url: repo.url,
                            is_official: repo.is_official || false
                        });
                    }
                }
            }
        }

        return relations;
    }

    calculatePaperQuality(entity) {
        let score = 0;

        // Abstract length
        const abstractLength = entity.body_content?.length || 0;
        if (abstractLength > 200) score += 20;
        if (abstractLength > 500) score += 10;

        // Has implementations
        const implCount = entity.meta_json?.repository_count || 0;
        score += Math.min(30, implCount * 10);

        // Has ArXiv link
        if (entity.meta_json?.arxiv_id) score += 10;

        // Has tasks/methods
        if (entity.tags.length > 2) score += 15;

        // Title quality
        if (entity.title.length > 20) score += 5;

        return Math.min(100, score);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default PapersWithCodeAdapter;
