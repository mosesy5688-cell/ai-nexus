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

import { BaseAdapter, NSFW_KEYWORDS, RateLimitExceededError } from './base-adapter.js';
import { ManifestEnricher } from './langchain-manifest.js';

const LANGCHAIN_API_BASE = 'https://api.smith.langchain.com';
// Hub manifest host (LANGCHAIN_HUB_BASE) is owned by ./langchain-manifest.js

/**
 * LangChain Hub Adapter Implementation
 */
export class LangChainAdapter extends BaseAdapter {
    constructor() {
        super('langchain');
        this.entityTypes = ['agent', 'prompt'];
        // V28 PR-3 (#2116 regression): one enricher per harvest run owns the
        // manifest circuit-breaker state (persists across batches; see
        // ManifestEnricher in ./langchain-manifest.js).
        this._enricher = new ManifestEnricher();
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
        const { limit = 2000, onBatch } = options;

        console.log(`📥 [LangChain] Fetching up to ${limit} prompts/agents...`);

        const allItems = [];
        let offset = 0;
        const pageSize = 100;
        let processedCount = 0;
        // V28 hang-fix: outer /repos/ listing 429 attempt counter (offset does NOT advance
        // on a 429 → same request retried → old flat 30s+continue spun forever). Drives
        // handleRateLimit() escalation + breaker; reset on success; breaker breaks the loop.
        // Scoped to listing only — manifest-body enrichment (#2116) is untouched.
        let attempt = 0;

        while (processedCount < limit) {
            // V21.1 Corrected Endpoint: /repos/ is the public listing
            const url = `${LANGCHAIN_API_BASE}/repos/?offset=${offset}&limit=${pageSize}&is_public=true&has_commits=true`;

            try {
                console.log(`   Fetching offset ${offset}...`);
                const response = await this.fetchWithTimeout(url, { headers: this.getHeaders() });

                if (!response.ok) {
                    if (response.status === 429) {
                        await this.handleRateLimit(response, attempt++); // V28: escalate + retry
                        continue;
                    }
                    throw new Error(`LangChain API error: ${response.status}`);
                }
                attempt = 0; // V28: page OK → reset 429 escalation counter

                const data = await response.json();
                const items = data.repos || [];

                if (items.length === 0) {
                    console.log('   No more items');
                    break;
                }

                const safeItems = items.filter(item => this.isSafeForWork(item));

                // R4-A: enrich each item with its real prompt body from the hub manifest
                // (per-batch, honest fallback to description on failure; #2116). Unchanged.
                await this.enrichBodies(safeItems);

                if (onBatch) {
                    await onBatch(safeItems);
                } else {
                    allItems.push(...safeItems);
                }

                processedCount += items.length;
                console.log(`   📦 Got ${safeItems.length}/${items.length} items (total: ${onBatch ? 'Streaming' : allItems.length})`);

                offset += pageSize;
                await this.delay(500); // Rate limiting

                if (items.length < pageSize) break; // Reached the end

            } catch (error) {
                // V28: breaker tripped → break-the-loop gracefully (keep what we have).
                if (error instanceof RateLimitExceededError) console.warn(`   🛑 [LangChain] rate-limit breaker tripped — finishing early.`);
                else console.error(`   ❌ Error: ${error.message}`);
                break;
            }
        }

        console.log(`✅ [LangChain] ${onBatch ? 'Streaming' : 'Fetched ' + allItems.length + ' items'} complete`);
        return onBatch ? [] : allItems.slice(0, limit);
    }

    /**
     * R4-A: enrich each item with its real prompt body from the hub manifest.
     * Delegates to the run-scoped ManifestEnricher, which owns the aggregate
     * circuit-breaker (#2116): the body is a NICE-TO-HAVE and must NEVER stall
     * the harvest — after N consecutive failures enrichment is disabled for the
     * rest of the run and items honestly fall back to description.
     * @param {Object[]} items - safe items for this batch (mutated in place)
     */
    async enrichBodies(items) {
        await this._enricher.enrich(items, this);
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
        const isAgent = this.detectIfAgent(raw);
        const type = isAgent ? 'agent' : 'prompt';
        const id = `langchain-${type}--${owner}--${handle}`;

        const entity = {
            id,
            type,
            name: raw.full_name || handle,
            author: owner,
            description: raw.description || '',
            // R4-A: prefer the enriched manifest body; honest fallback to description
            body_content: raw._body || raw.description || '',
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

        // R4-B: return a real string[]. Previously this joined to a comma
        // string, which the shared merger then spread ([...string]) into
        // single characters. Every other adapter returns an array.
        return Array.from(tags);
    }
}

export default LangChainAdapter;
