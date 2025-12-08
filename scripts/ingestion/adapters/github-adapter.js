/**
 * GitHub Adapter
 * 
 * Fetches ML/AI repositories from GitHub API:
 * - Full README content
 * - Repository metadata (stars, forks, language)
 * - License information
 * - Relationship discovery
 * 
 * @module ingestion/adapters/github-adapter
 */

import { BaseAdapter } from './base-adapter.js';

const GH_API_BASE = 'https://api.github.com';

/**
 * GitHub Adapter Implementation
 */
export class GitHubAdapter extends BaseAdapter {
    constructor() {
        super('github');
        this.entityTypes = ['tool', 'model'];
        this.token = process.env.GITHUB_TOKEN || null;
    }

    /**
     * Get headers for GitHub API requests
     */
    getHeaders() {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Free2AITools-Ingestion/3.2'
        };
        if (this.token) {
            headers['Authorization'] = `token ${this.token}`;
        }
        return headers;
    }

    /**
     * Fetch ML/AI repositories from GitHub
     * @param {Object} options
     * @param {number} options.limit - Number of repos to fetch (default: 200)
     * @param {string[]} options.topics - Topics to search for
     */
    async fetch(options = {}) {
        const {
            limit = 200,
            topics = ['machine-learning', 'deep-learning', 'ai', 'llm', 'transformers']
        } = options;

        console.log(`📥 [GitHub] Fetching top ${limit} ML/AI repositories...`);

        const allRepos = [];
        const perPage = Math.min(100, limit);
        const maxPages = Math.ceil(limit / perPage);
        const seenIds = new Set();

        // Search by multiple topics
        for (const topic of topics) {
            if (allRepos.length >= limit) break;

            const query = `topic:${topic} stars:>100`;
            const searchUrl = `${GH_API_BASE}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;

            try {
                const response = await fetch(searchUrl, { headers: this.getHeaders() });

                if (!response.ok) {
                    console.warn(`   ⚠️ GitHub search failed for ${topic}: ${response.status}`);
                    continue;
                }

                const data = await response.json();
                const repos = data.items || [];

                for (const repo of repos) {
                    if (!seenIds.has(repo.id) && allRepos.length < limit) {
                        seenIds.add(repo.id);
                        allRepos.push(repo);
                    }
                }

                console.log(`   Found ${repos.length} repos for topic: ${topic}`);
                await this.delay(1000); // Rate limiting
            } catch (error) {
                console.warn(`   ⚠️ Error searching ${topic}: ${error.message}`);
            }
        }

        console.log(`📦 [GitHub] Got ${allRepos.length} unique repositories`);

        // Fetch full details including README
        console.log(`🔄 [GitHub] Fetching full details...`);
        const fullRepos = [];
        const batchSize = 5; // Lower batch size due to rate limits

        for (let i = 0; i < allRepos.length; i += batchSize) {
            const batch = allRepos.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(r => this.fetchFullRepo(r.full_name))
            );
            fullRepos.push(...batchResults.filter(r => r !== null));

            if ((i + batchSize) % 20 === 0 || i + batchSize >= allRepos.length) {
                console.log(`   Progress: ${Math.min(i + batchSize, allRepos.length)}/${allRepos.length}`);
            }

            // Delay to avoid rate limiting
            await this.delay(500);
        }

        console.log(`✅ [GitHub] Fetched ${fullRepos.length} complete repositories`);
        return fullRepos;
    }

    /**
     * Fetch complete repository details including README
     */
    async fetchFullRepo(fullName) {
        try {
            // Fetch repo details
            const repoUrl = `${GH_API_BASE}/repos/${fullName}`;
            const repoResponse = await fetch(repoUrl, { headers: this.getHeaders() });

            if (!repoResponse.ok) {
                return null;
            }

            const repo = await repoResponse.json();

            // Fetch README
            const readmeUrl = `${GH_API_BASE}/repos/${fullName}/readme`;
            let readme = '';
            try {
                const readmeResponse = await fetch(readmeUrl, {
                    headers: { ...this.getHeaders(), 'Accept': 'application/vnd.github.v3.raw' }
                });
                if (readmeResponse.ok) {
                    readme = await readmeResponse.text();
                    // Truncate to 100KB
                    if (readme.length > 100000) {
                        readme = readme.substring(0, 100000) + '\n\n[Content truncated...]';
                    }
                }
            } catch (e) {
                // README fetch failed
            }

            return {
                ...repo,
                readme,
                _fetchedAt: new Date().toISOString()
            };
        } catch (error) {
            console.warn(`   ⚠️ Error fetching ${fullName}: ${error.message}`);
            return null;
        }
    }

    /**
     * Normalize raw GitHub repo to UnifiedEntity
     */
    normalize(raw) {
        const owner = raw.owner?.login || 'unknown';
        const name = raw.name || 'unknown';

        const entity = {
            // Identity
            id: this.generateId(owner, name),
            type: this.inferType(raw),
            source: 'github',
            source_url: raw.html_url,

            // Content
            title: name,
            description: this.extractDescription(raw.readme) || raw.description || '',
            body_content: raw.readme || '',
            tags: this.extractTags(raw),

            // Metadata
            author: owner,
            license_spdx: this.normalizeLicense(raw.license?.spdx_id),
            meta_json: this.buildMetaJson(raw),
            created_at: raw.created_at,
            updated_at: raw.pushed_at,

            // Metrics
            popularity: raw.stargazers_count || 0,
            downloads: 0, // GitHub doesn't have downloads

            // Assets - GitHub repos typically don't have meaningful images
            raw_image_url: null,

            // Relations
            relations: [],

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Discover relations
        entity.relations = this.discoverRelations(entity);

        // Calculate system fields
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        return entity;
    }

    /**
     * Extract assets - GitHub repos typically don't have meaningful cover images
     */
    extractAssets(raw) {
        // Could potentially extract images from README, but for now return empty
        return [];
    }

    // ============================================================
    // Helper Methods
    // ============================================================

    inferType(raw) {
        const language = (raw.language || '').toLowerCase();
        const description = (raw.description || '').toLowerCase();
        const topics = raw.topics || [];

        // Check for model indicators
        const modelIndicators = ['model', 'weights', 'checkpoint', 'pretrained'];
        if (modelIndicators.some(ind => description.includes(ind) ||
            topics.some(t => t.includes(ind)))) {
            return 'model';
        }

        // Default to tool for code repositories
        return 'tool';
    }

    extractTags(raw) {
        const tags = [];

        // Add topics
        if (Array.isArray(raw.topics)) {
            tags.push(...raw.topics);
        }

        // Add language
        if (raw.language) {
            tags.push(raw.language.toLowerCase());
        }

        return tags
            .map(t => t.toLowerCase().trim())
            .filter(t => t.length > 0 && t.length < 50);
    }

    buildMetaJson(raw) {
        return {
            language: raw.language || null,
            stars: raw.stargazers_count || 0,
            forks: raw.forks_count || 0,
            watchers: raw.watchers_count || 0,
            open_issues: raw.open_issues_count || 0,
            topics: raw.topics || [],
            default_branch: raw.default_branch || 'main',
            size_kb: raw.size || 0,
            archived: raw.archived || false,
            fork: raw.fork || false,
            has_wiki: raw.has_wiki || false,
            has_pages: raw.has_pages || false
        };
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default GitHubAdapter;
