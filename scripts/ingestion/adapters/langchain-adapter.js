/**
 * LangChain Hub Adapter
 * 
 * B.1 New Data Source Integration
 * Fetches prompts and agents from LangChain Hub API
 * 
 * API: GET https://api.smith.langchain.com/api/v1/public/prompts
 * Expected: +2K agents/prompts
 * 
 * @module ingestion/adapters/langchain-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

const LANGCHAIN_API_BASE = 'https://api.smith.langchain.com/api/v1/public';

/**
 * LangChain Hub Adapter Implementation
 */
export class LangChainAdapter extends BaseAdapter {
    constructor() {
        super('langchain');
        this.entityTypes = ['agent', 'prompt'];
    }

    /**
     * Get request headers
     */
    getHeaders() {
        return {
            'Accept': 'application/json',
            'User-Agent': 'Free2AITools/1.0'
        };
    }

    /**
     * Fetch prompts/agents from LangChain Hub API
     * @param {Object} options
     * @param {number} options.limit - Number of items to fetch (default: 2000)
     */
    async fetch(options = {}) {
        const { limit = 2000 } = options;

        console.log(`📥 [LangChain] Fetching up to ${limit} prompts/agents...`);

        const allItems = [];
        let offset = 0;
        const pageSize = 100;

        while (allItems.length < limit) {
            const url = `${LANGCHAIN_API_BASE}/prompts?offset=${offset}&limit=${pageSize}`;

            try {
                console.log(`   Fetching offset ${offset}...`);
                const response = await fetch(url, { headers: this.getHeaders() });

                if (!response.ok) {
                    if (response.status === 429) {
                        console.warn('   ⚠️ Rate limited, waiting 30s...');
                        await this.delay(30000);
                        continue;
                    }
                    throw new Error(`LangChain API error: ${response.status}`);
                }

                const data = await response.json();
                const items = data.repos || data.prompts || data.results || [];

                if (items.length === 0) {
                    console.log('   No more items');
                    break;
                }

                // Filter safe items
                const safeItems = items.filter(item => this.isSafeForWork(item));
                allItems.push(...safeItems);

                console.log(`   📦 Got ${safeItems.length}/${items.length} items (total: ${allItems.length})`);

                offset += pageSize;
                await this.delay(500); // Rate limiting

                // Check if we've reached the end
                if (items.length < pageSize) break;

            } catch (error) {
                console.error(`   ❌ Error: ${error.message}`);
                break;
            }
        }

        console.log(`✅ [LangChain] Fetched ${allItems.length} items`);
        return allItems.slice(0, limit);
    }

    /**
     * Check if item is safe for work
     * @param {Object} item
     */
    isSafeForWork(item) {
        const name = (item.repo_handle || item.name || '').toLowerCase();
        const description = (item.description || '').toLowerCase();
        const text = `${name} ${description}`;

        return !NSFW_KEYWORDS.some(keyword => text.includes(keyword));
    }

    /**
     * Normalize a LangChain Hub item to Universal Entity format
     * @param {Object} raw
     */
    normalize(raw) {
        const handle = raw.repo_handle || raw.name || 'unknown';
        const owner = raw.owner || 'langchain';
        const id = `langchain/${owner}/${handle}`;

        // Determine entity type
        const isAgent = this.detectIfAgent(raw);

        return {
            id,
            type: isAgent ? 'agent' : 'prompt',
            name: raw.full_name || handle,
            author: owner,
            description: raw.description || '',
            source: 'langchain',
            source_url: `https://smith.langchain.com/hub/${owner}/${handle}`,

            // Stats
            likes: raw.num_likes || raw.stars || 0,
            downloads: raw.num_downloads || raw.pulls || 0,
            forks: raw.num_forks || 0,

            // Timestamps
            created_at: raw.created_at,
            last_modified: raw.updated_at || raw.created_at,

            // Classification
            pipeline_tag: isAgent ? 'agent' : 'prompt-template',
            primary_category: isAgent ? 'agents' : 'prompts',
            tags: this.extractTags(raw),

            // Agent-specific fields
            framework: 'langchain',
            agent_type: isAgent ? (raw.tags?.includes('autonomous') ? 'autonomous' : 'agentic') : null,

            // Metadata
            meta_json: JSON.stringify({
                is_public: raw.is_public ?? true,
                num_commits: raw.num_commits || 0,
                num_views: raw.num_views || 0,
                tags: raw.tags || [],
                manifest: raw.manifest || null
            }),

            // FNI will be calculated later
            fni_score: 0,

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Calculate system fields
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        return entity;
    }

    /**
     * Detect if item is an agent vs simple prompt
     */
    detectIfAgent(raw) {
        const name = (raw.repo_handle || raw.name || '').toLowerCase();
        const description = (raw.description || '').toLowerCase();
        const tags = raw.tags || [];

        // Check tags
        if (tags.some(t => ['agent', 'agents', 'autonomous', 'agentic'].includes(t.toLowerCase()))) {
            return true;
        }

        // Check name/description
        const agentKeywords = ['agent', 'assistant', 'copilot', 'bot', 'workflow', 'chain'];
        return agentKeywords.some(kw => name.includes(kw) || description.includes(kw));
    }

    /**
     * Extract tags from item
     */
    extractTags(raw) {
        const tags = new Set(raw.tags || []);

        // Add framework tag
        tags.add('langchain');

        // Add type tag
        if (this.detectIfAgent(raw)) {
            tags.add('agent');
        } else {
            tags.add('prompt');
        }

        return Array.from(tags).join(',');
    }
}

export default LangChainAdapter;
