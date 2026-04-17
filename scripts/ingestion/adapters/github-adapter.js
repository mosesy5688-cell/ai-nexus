/**
 * GitHub Adapter
 * 
 * Fetches ML/AI repositories from GitHub API:
 * - Full README content
 * - Repository metadata (stars, forks, language)
 * - License information
 * - Relationship discovery
 * 
 * V2.1: Added NSFW filter and AI organization detection
 * 
 * @module ingestion/adapters/github-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

const GH_API_BASE = 'https://api.github.com';

/**
 * V2.1: AI Organizations whitelist for model detection
 * Repos from these orgs are likely to be models, not tools
 */
const AI_ORGANIZATIONS = [
    'meta-llama', 'google', 'openai', 'microsoft', 'anthropic',
    'mistralai', 'huggingface', 'deepseek-ai', 'alibaba', 'baichuan-inc',
    'internlm', 'qwen', 'bigscience', 'stabilityai', 'runwayml',
    'nvidia', 'amd', 'intel', 'tiiuae', 'mosaicml', 'together-ai',
    '01-ai', 'cohere', 'allenai', 'eleutherai', 'bigcode-project'
];

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
     * Fetch ML/AI repositories from GitHub using GraphQL
     * V22.4: 66% request reduction via single-query metadata + README block
     */
    async fetch(options = {}) {
        const {
            limit = 10000,
            topics = [
                'machine-learning', 'deep-learning', 'artificial-intelligence', 'neural-network',
                'llm', 'large-language-model', 'transformers', 'nlp', 'chatgpt', 'gpt',
                'computer-vision', 'image-generation', 'stable-diffusion', 'diffusion-models',
                'pytorch', 'tensorflow', 'huggingface', 'langchain', 'llamaindex', 'autogen', 'crewai',
                'ai-agent', 'autonomous-agents', 'ai-tools', 'rag', 'agentic', 'chatbot', 'data-science'
            ],
            pagesPerTopic = 10
        } = options;

        if (!this.token) {
            console.error('❌ [GitHub] GITHUB_TOKEN is required for GraphQL API');
            return [];
        }

        console.log(`📥 [GitHub] GraphQL Ingestion: Fetching top ${limit} repos across ${topics.length} topics...`);

        const allRepos = [];
        const seenIds = new Set();
        const perPage = 50; // GraphQL recommendation for stable performance

        const GQL_QUERY = `
            query($queryString: String!, $after: String, $first: Int!) {
              search(query: $queryString, type: REPOSITORY, first: $first, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  ... on Repository {
                    databaseId
                    name
                    nameWithOwner
                    description
                    url: homepageUrl
                    htmlUrl: url
                    stargazerCount
                    forkCount
                    watchers { totalCount }
                    issues(states: OPEN) { totalCount }
                    primaryLanguage { name }
                    repositoryTopics(first: 20) {
                      nodes { topic { name } }
                    }
                    licenseInfo { spdxId }
                    createdAt
                    pushedAt
                    defaultBranchRef { name }
                    owner { login avatarUrl }
                    readme: object(expression: "HEAD:README.md") {
                      ... on Blob { text }
                    }
                    readmeLower: object(expression: "HEAD:readme.md") {
                      ... on Blob { text }
                    }
                  }
                }
              }
            }
        `;

        const failedTopics = []; // V26.13: Track topics that exhausted retries for a second pass

        for (const topic of topics) {
            if (allRepos.length >= limit) break;
            let after = null;
            let retries = 0;

            for (let page = 1; page <= pagesPerTopic; page++) {
                if (allRepos.length >= limit) break;

                const queryVariables = {
                    queryString: `topic:${topic} sort:stars-desc`,
                    first: perPage,
                    after: after
                };

                try {
                    const response = await fetch(`${GH_API_BASE}/graphql`, {
                        method: 'POST',
                        headers: {
                            ...this.getHeaders(),
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ query: GQL_QUERY, variables: queryVariables })
                    });

                    if (!response.ok) {
                        if (await this.handleRateLimit(response)) {
                            page--; continue;
                        }
                        // V26.13: Retry on 502/503/504 with exponential backoff + jitter (max 5 retries)
                        if ((response.status === 502 || response.status === 503 || response.status === 504) && retries < 5) {
                            retries++;
                            const baseMs = Math.min(10000 * Math.pow(2, retries - 1), 120000); // 10s→20s→40s→80s→120s cap
                            const jitter = Math.floor(Math.random() * 5000); // 0-5s jitter
                            const backoff = baseMs + jitter;
                            console.warn(`   ⚠️ GitHub GQL ${response.status}, retry ${retries}/5 in ${(backoff / 1000).toFixed(1)}s...`);
                            await this.delay(backoff);
                            page--; continue;
                        }
                        console.warn(`   ⚠️ GitHub GQL failed: ${response.status} — skipping ${topic} (will retry later)`);
                        failedTopics.push({ topic, after, page });
                        break;
                    }
                    retries = 0;

                    const result = await response.json();
                    if (result.errors) {
                        console.warn(`   ⚠️ GraphQL Errors: ${result.errors[0].message}`);
                        break;
                    }

                    const searchData = result.data.search;
                    const nodes = searchData.nodes || [];
                    if (nodes.length === 0) break;

                    const batch = [];
                    for (const node of nodes) {
                        if (!node || !node.databaseId) continue;

                        // NSFW Filter
                        if (!this.isSafeForWork({ name: node.name, description: node.description })) continue;

                        if (!seenIds.has(node.databaseId) && allRepos.length < limit) {
                            seenIds.add(node.databaseId);

                            const mappedRepo = this._mapGraphQLNode(node);
                            batch.push(mappedRepo);
                            allRepos.push(mappedRepo);
                        }
                    }

                    if (options.onBatch && batch.length > 0) {
                        await options.onBatch(batch);
                    }

                    console.log(`   ${topic} p${page}: +${batch.length} repos (total: ${allRepos.length})`);

                    if (!searchData.pageInfo.hasNextPage) break;
                    after = searchData.pageInfo.endCursor;

                    await this.delay(1000); // Respect GQL complexity limits

                } catch (error) {
                    console.warn(`   ⚠️ GQL error searching ${topic}: ${error.message}`);
                    break;
                }
            }
        }

        // V26.13: Retry round for topics that failed due to transient 502/503/504
        if (failedTopics.length > 0 && allRepos.length < limit) {
            console.log(`   🔄 [GitHub] Retry round: ${failedTopics.length} failed topics...`);
            await this.delay(30000); // 30s cooldown before retry round
            for (const { topic, after: savedAfter, page: savedPage } of failedTopics) {
                if (allRepos.length >= limit) break;
                let after = savedAfter;
                for (let page = savedPage; page <= pagesPerTopic; page++) {
                    if (allRepos.length >= limit) break;
                    const queryVariables = { queryString: `topic:${topic} sort:stars-desc`, first: perPage, after };
                    try {
                        const response = await fetch(`${GH_API_BASE}/graphql`, {
                            method: 'POST',
                            headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
                            body: JSON.stringify({ query: GQL_QUERY, variables: queryVariables })
                        });
                        if (!response.ok) {
                            if (await this.handleRateLimit(response)) { page--; continue; }
                            console.warn(`   ⚠️ [Retry] GitHub GQL ${response.status} — giving up on ${topic}`);
                            break;
                        }
                        const result = await response.json();
                        if (result.errors) break;
                        const searchData = result.data.search;
                        const nodes = searchData.nodes || [];
                        if (nodes.length === 0) break;
                        const batch = [];
                        for (const node of nodes) {
                            if (!node || !node.databaseId) continue;
                            if (!this.isSafeForWork({ name: node.name, description: node.description })) continue;
                            if (!seenIds.has(node.databaseId) && allRepos.length < limit) {
                                seenIds.add(node.databaseId);
                                const mappedRepo = this._mapGraphQLNode(node);
                                batch.push(mappedRepo);
                                allRepos.push(mappedRepo);
                            }
                        }
                        if (options.onBatch && batch.length > 0) await options.onBatch(batch);
                        console.log(`   [Retry] ${topic} p${page}: +${batch.length} repos (total: ${allRepos.length})`);
                        if (!searchData.pageInfo.hasNextPage) break;
                        after = searchData.pageInfo.endCursor;
                        await this.delay(1000);
                    } catch (error) {
                        console.warn(`   ⚠️ [Retry] GQL error on ${topic}: ${error.message}`);
                        break;
                    }
                }
            }
        }

        console.log(`✅ [GitHub] GraphQL Fetch Complete: ${allRepos.length} repositories`);
        return options.onBatch ? [] : allRepos;
    }

    /**
     * Normalize raw GitHub repo to UnifiedEntity
     */
    normalize(raw) {
        const owner = raw.owner?.login || 'unknown';
        const name = raw.name || 'unknown';

        const entityType = this.inferType(raw);
        const entity = {
            // Identity
            id: this.generateId(owner, name, entityType),
            type: entityType,
            source: 'github',
            source_url: raw.html_url,

            // Content
            title: name,
            description: this.extractDescription(raw.readme) || raw.description || '',
            body_content: (raw.readme || '') + (raw.quick_start ? `\n\n### 🚀 Quick Start\n\`\`\`bash\n${raw.quick_start}\n\`\`\`` : ''),
            tags: this.extractTags(raw),

            // Structural Top-Level Promotion
            github_quick_start: raw.quick_start || null,

            // V6.0: Pipeline tag inferred from topics for category assignment
            pipeline_tag: this.inferPipelineTag(raw.topics),

            // Metadata
            author: owner,
            license_spdx: this.normalizeLicense(raw.license?.spdx_id),
            meta_json: this.buildMetaJson(raw),
            created_at: raw.created_at,
            updated_at: raw.pushed_at,

            // V24.12: Promoted fields for DB schema expansion
            primary_language: raw.language || '',
            forks: raw.forks_count || 0,

            // Metrics
            popularity: raw.stargazers_count || 0,
            downloads: 0, // GitHub doesn't have downloads

            // Assets - V16.7.1: Extract "Helpful" images from README and Social Previews
            raw_image_url: this.extractAssets(raw)[0]?.url || null,

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
     * Extract assets - V16.7.1: Extract "Helpful" images from README and Social Previews
     * GitHub uses specific OpenGraph images and README-linked files.
     */
    extractAssets(raw) {
        const assets = [];
        const fullName = raw.full_name;

        // Priority 1: GitHub Social Preview (High quality, repo-specific)
        // Format: https://opengraph.githubassets.com/[random_hash]/[owner]/[repo]
        // But the standard direct one is often more reliable:
        assets.push({
            type: 'social_preview',
            url: `https://repository-images.githubusercontent.com/${raw.id}/social_preview`
        });

        // Priority 2: README Images (Substantive visuals)
        if (raw.readme) {
            // Regex to find images, excluding badges/shields/icons
            // Matches markdown: ![alt](url)
            const imgPattern = /!\[.*?\]\(((?!http|.*badge|.*shield|.*img\.shields|.*travis-ci|.*github\.com\/.*\/badges)[^)]+\.(webp|png|jpg|jpeg|gif))\)/gi;
            let match;
            while ((match = imgPattern.exec(raw.readme)) !== null) {
                const url = match[1];
                // Resolve relative URLs
                const absoluteUrl = url.startsWith('http') ? url :
                    `https://raw.githubusercontent.com/${fullName}/${raw.default_branch || 'main'}/${url.replace(/^\.\//, '')}`;

                assets.push({
                    type: 'readme_image',
                    url: absoluteUrl
                });
                if (assets.length > 5) break; // Don't overdo it
            }
        }

        // Priority 3: Author Avatar (Universal Branding)
        if (raw.owner?.avatar_url) {
            assets.push({
                type: 'author_avatar',
                url: raw.owner.avatar_url
            });
        }

        return assets;
    }

    /**
     * V26.13: Map GraphQL node to legacy REST structure for normalize() compatibility
     */
    _mapGraphQLNode(node) {
        return {
            id: node.databaseId,
            name: node.name,
            full_name: node.nameWithOwner,
            description: node.description,
            html_url: node.htmlUrl,
            stargazers_count: node.stargazerCount,
            forks_count: node.forkCount,
            watchers_count: node.watchers?.totalCount || 0,
            open_issues_count: node.issues?.totalCount || 0,
            language: node.primaryLanguage?.name || null,
            topics: node.repositoryTopics?.nodes?.map(n => n.topic.name) || [],
            license: node.licenseInfo ? { spdx_id: node.licenseInfo.spdxId } : null,
            created_at: node.createdAt,
            pushed_at: node.pushedAt,
            default_branch: node.defaultBranchRef?.name || 'main',
            owner: { login: node.owner?.login, avatar_url: node.owner?.avatarUrl },
            readme: node.readme?.text || node.readmeLower?.text || '',
            quick_start: this.extractQuickStartFromReadme(node.readme?.text || node.readmeLower?.text || '')
        };
    }

    /**
     * V19.5 Phase 3: Extract "Quick Start" commands from raw README string.
     * Looks for pip, npm, git clone, docker pull. Returns first block found.
     */
    extractQuickStartFromReadme(readmeText) {
        if (!readmeText) return null;

        // Scan for code blocks ```bash or just ```
        const codeBlockPattern = /```[\w]*\n([\s\S]*?)```/g;
        let match;

        while ((match = codeBlockPattern.exec(readmeText)) !== null) {
            const blockContent = match[1].trim();
            // Verify if block contains typical install commands
            if (
                /^(\$ |> )?(pip install|npm install|npm i|yarn add|git clone|docker pull|docker run|brew install)/mi.test(blockContent)
            ) {
                // Clean off leading typical shell markers $ or >
                return blockContent.replace(/^(\$|>)\s/gm, '');
            }
        }

        // Secondary fallback - just finding raw code lines without block quotes if they are clearly install instructions
        const lines = readmeText.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^(\$ |> |`|)(pip install|docker pull)[^`]*(`|)$/i.test(trimmed)) {
                return trimmed.replace(/[`$>]/g, '').trim();
            }
        }

        return null;
    }

    // ============================================================
    // Helper Methods
    // ============================================================

    inferType(raw) {
        const owner = (raw.owner?.login || '').toLowerCase();
        const description = (raw.description || '').toLowerCase();
        const topics = raw.topics || [];

        // V2.1: AI Organization detection (whitelist-based, no inference)
        if (AI_ORGANIZATIONS.some(org => owner.includes(org))) {
            return 'model';
        }

        // Check for model indicators in description/topics
        const modelIndicators = ['model', 'weights', 'checkpoint', 'pretrained', 'llm', 'transformer'];
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
