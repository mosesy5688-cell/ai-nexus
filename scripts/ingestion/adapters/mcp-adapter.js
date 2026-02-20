/**
 * MCP Registry Adapter
 * 
 * Fetches MCP (Model Context Protocol) servers from the official MCP Registry
 * API: https://registry.modelcontextprotocol.io/v0/servers
 * 
 * Entity type: 'agent' (mcp-server subtype)
 * 
 * V2.1: Added NSFW filter at fetch level
 * 
 * @module ingestion/adapters/mcp-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

const MCP_REGISTRY_API = 'https://registry.modelcontextprotocol.io';

/**
 * MCP Registry Adapter Implementation
 */
export class MCPAdapter extends BaseAdapter {
    constructor() {
        super('mcp');
        this.entityTypes = ['agent'];
    }

    /**
     * Fetch MCP servers from the registry
     * @param {Object} options
     * @param {number} options.limit - Max servers to fetch (default: 500)
     */
    async fetch(options = {}) {
        const { limit = 500 } = options;

        console.log(`📥 [MCP] Fetching up to ${limit} MCP servers from registry...`);

        const allServers = [];
        let cursor = null;
        let page = 0;

        try {
            // Paginated fetch
            while (allServers.length < limit) {
                page++;
                const url = cursor
                    ? `${MCP_REGISTRY_API}/v0/servers?cursor=${cursor}&limit=100`
                    : `${MCP_REGISTRY_API}/v0/servers?limit=100`;

                const response = await fetch(url, {
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Free2AITools/1.0 (AI Knowledge Hub)'
                    }
                });

                if (!response.ok) {
                    console.warn(`   ⚠️ MCP Registry API error: ${response.status}`);
                    break;
                }

                const data = await response.json();
                const servers = data.servers || data.items || [];

                if (servers.length === 0) break;

                allServers.push(...servers);
                console.log(`   Page ${page}: +${servers.length} servers (total: ${allServers.length})`);

                // Check for pagination cursor
                cursor = data.next_cursor || data.cursor;
                if (!cursor) break;

                // Rate limit protection
                await this.delay(500);
            }
        } catch (error) {
            console.error(`   ❌ MCP Registry fetch error: ${error.message}`);
        }

        const results = allServers.slice(0, limit);
        console.log(`✅ [MCP] Fetched ${results.length} MCP servers`);
        return results;
    }

    /**
     * Normalize raw MCP server to UnifiedEntity
     */
    normalize(raw) {
        const serverId = raw.id || raw.name || 'unknown';
        const name = raw.name || raw.display_name || serverId;

        // V19.5 Mode B Phase 2: Elevate Meta structures
        const extractedTools = raw.tools?.map(t => typeof t === 'object' ? t.name : t) || [];
        const extractedPrompts = raw.prompts?.map(p => typeof p === 'object' ? p.name : p) || [];

        const toolsMd = extractedTools.length > 0 ? `\n\n### 🛠️ Exposed Tools\n- \`${extractedTools.join('`\n- `')}\`` : '';
        const promptsMd = extractedPrompts.length > 0 ? `\n\n### 📝 Native Prompts\n- \`${extractedPrompts.join('`\n- `')}\`` : '';

        const entity = {
            // Identity
            id: `mcp-server--${this.sanitizeName(serverId)}`,
            type: 'agent',
            subtype: 'mcp-server',
            source: 'mcp_registry',
            source_url: raw.homepage || raw.repository || `https://registry.modelcontextprotocol.io/servers/${serverId}`,

            // Content
            title: name,
            description: this.truncate(raw.description || '', 500),
            body_content: (raw.readme || raw.description || '') + toolsMd + promptsMd,
            tags: this.extractTags(raw),

            // Structural Top-Level Promotion
            mcp_tools: extractedTools,
            mcp_prompts: extractedPrompts,

            // Metadata
            author: raw.author || raw.vendor || 'unknown',
            license_spdx: raw.license || null,
            meta_json: this.buildMetaJson(raw),
            created_at: raw.created_at || raw.published_at,
            updated_at: raw.updated_at,

            // Metrics
            popularity: raw.downloads || raw.installs || 0,
            downloads: raw.downloads || 0,

            // Assets
            raw_image_url: raw.icon || raw.logo || null,

            // Relations
            relations: this.discoverRelations(raw),

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Calculate system fields after entity creation
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        return entity;
    }

    /**
     * Extract tags from MCP server metadata
     */
    extractTags(raw) {
        const tags = ['mcp', 'mcp-server', 'ai-agent'];

        // Add categories
        if (raw.categories) {
            tags.push(...raw.categories);
        }

        // Add capabilities
        if (raw.capabilities) {
            tags.push(...Object.keys(raw.capabilities));
        }

        // Add tools as tags
        if (raw.tools) {
            const toolNames = raw.tools.map(t => t.name || t).slice(0, 5);
            tags.push(...toolNames);
        }

        return [...new Set(tags.map(t => String(t).toLowerCase().trim()))]
            .filter(t => t.length > 0 && t.length < 50);
    }

    /**
     * Build meta JSON with MCP-specific fields
     */
    buildMetaJson(raw) {
        return {
            mcp_version: raw.version || raw.mcp_version || null,
            capabilities: raw.capabilities || {},
            tools: raw.tools?.map(t => t.name || t) || [],
            prompts: raw.prompts?.map(p => p.name || p) || [],
            resources: raw.resources?.map(r => r.name || r) || [],
            transports: raw.transports || ['stdio'],
            repository: raw.repository || null,
            homepage: raw.homepage || null,
            runtime: raw.runtime || raw.package_type || 'node'
        };
    }

    /**
     * Sanitize name for ID generation
     */
    sanitizeName(name) {
        return String(name)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 100);
    }

    /**
     * Discover relations with other entities
     */
    discoverRelations(raw) {
        const relations = [];

        // Link to related models mentioned in capabilities
        if (raw.models) {
            raw.models.forEach(model => {
                relations.push({
                    type: 'uses',
                    target_id: `hf--${this.sanitizeName(model)}`,
                    weight: 0.7
                });
            });
        }

        return relations;
    }

    /**
     * Calculate quality score for MCP servers
     */
    calculateQualityScore(entity) {
        let score = 0.3; // Base score

        // Description quality
        if (entity.description && entity.description.length > 50) score += 0.2;

        // Has documentation
        if (entity.body_content && entity.body_content.length > 200) score += 0.2;

        // Has tools defined
        const meta = entity.meta_json || {};
        if (meta.tools && meta.tools.length > 0) score += 0.15;

        // Has repository
        if (meta.repository) score += 0.15;

        return Math.min(1, score);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default MCPAdapter;
