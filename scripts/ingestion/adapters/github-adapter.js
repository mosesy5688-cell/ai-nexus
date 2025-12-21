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
            // V6.2: Expanded topic list for broader coverage
            topics = [
                // Core AI/ML
                'machine-learning', 'deep-learning', 'artificial-intelligence', 'neural-network',
                // LLM & NLP
                'llm', 'large-language-model', 'transformers', 'nlp', 'chatgpt', 'gpt',
                // Computer Vision
                'computer-vision', 'image-generation', 'stable-diffusion', 'diffusion-models',
                // Frameworks
                'pytorch', 'tensorflow', 'huggingface', 'langchain', 'llamaindex',
                // Agents & Tools
                'ai-agent', 'autonomous-agents', 'ai-tools', 'rag'
            ],
            pagesPerTopic = 5  // V4.2: Increased from 2 to 5 for better coverage
        } = options;

        console.log(`📥 [GitHub] Fetching top ${limit} ML/AI repositories across ${topics.length} topics...`);

        const allRepos = [];
        const perPage = 100;  // Max per page
        const seenIds = new Set();

        // Search by multiple topics with pagination
        for (const topic of topics) {
            if (allRepos.length >= limit) break;

            // V6.2: Paginate within each topic
            for (let page = 1; page <= pagesPerTopic; page++) {
                if (allRepos.length >= limit) break;

                const query = `topic:${topic} stars:>50`;  // Lowered from 100 for more results
                const searchUrl = `${GH_API_BASE}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;

                try {
                    const response = await fetch(searchUrl, { headers: this.getHeaders() });

                    if (!response.ok) {
                        if (response.status === 403) {
                            console.warn(`   ⚠️ Rate limited, waiting...`);
                            await this.delay(5000);
                            continue;
                        }
                        console.warn(`   ⚠️ GitHub search failed for ${topic} p${page}: ${response.status}`);
                        break;  // Move to next topic
                    }

                    const data = await response.json();
                    const repos = data.items || [];

                    if (repos.length === 0) break;  // No more results for this topic

                    let addedCount = 0;
                    for (const repo of repos) {
                        if (!seenIds.has(repo.id) && allRepos.length < limit) {
                            seenIds.add(repo.id);
                            allRepos.push(repo);
                            addedCount++;
                        }
                    }

                    console.log(`   ${topic} p${page}: +${addedCount} repos (total: ${allRepos.length})`);
                    await this.delay(1500);  // Rate limit protection
                } catch (error) {
                    console.warn(`   ⚠️ Error searching ${topic}: ${error.message}`);
                    break;
                }
            }
        }

        console.log(`📦 [GitHub] Got ${allRepos.length} unique repositories`);

        // Fetch full details including README
        console.log(`🔄 [GitHub] Fetching full details...`);
        const fullRepos = [];
        const batchSize = 5;

        for (let i = 0; i < allRepos.length; i += batchSize) {
            const batch = allRepos.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(r => this.fetchFullRepo(r.full_name))
            );
            fullRepos.push(...batchResults.filter(r => r !== null));

            if ((i + batchSize) % 50 === 0 || i + batchSize >= allRepos.length) {
                console.log(`   Progress: ${Math.min(i + batchSize, allRepos.length)}/${allRepos.length}`);
            }

            await this.delay(1000);
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

            // V6.0: Pipeline tag inferred from topics for category assignment
            pipeline_tag: this.inferPipelineTag(raw.topics),

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

    /**
     * V6.0: Infer pipeline_tag from GitHub topics for category assignment
     */
    inferPipelineTag(topics) {
        const topicsLower = (topics || []).map(t => t.toLowerCase());

        // Text generation indicators
        if (topicsLower.some(t => ['llm', 'gpt', 'chat', 'language-model', 'chatbot', 'text-generation'].includes(t))) {
            return 'text-generation';
        }

        // Image generation indicators
        if (topicsLower.some(t => ['stable-diffusion', 'diffusion', 'image-generation', 'text-to-image', 'sdxl'].includes(t))) {
            return 'text-to-image';
        }

        // Embedding/RAG indicators
        if (topicsLower.some(t => ['embedding', 'sentence-transformers', 'rag', 'vector-database'].includes(t))) {
            return 'feature-extraction';
        }

        // Speech/Audio indicators
        if (topicsLower.some(t => ['speech-recognition', 'tts', 'text-to-speech', 'whisper', 'asr'].includes(t))) {
            return 'automatic-speech-recognition';
        }

        // Computer vision indicators
        if (topicsLower.some(t => ['object-detection', 'image-classification', 'yolo', 'segmentation'].includes(t))) {
            return 'object-detection';
        }

        return 'other';
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
