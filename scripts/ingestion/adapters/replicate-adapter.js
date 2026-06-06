/**
 * Replicate Adapter
 * 
 * B.1 New Data Source Integration
 * Fetches models from Replicate API
 * 
 * API: GET https://api.replicate.com/v1/models
 * Expected: +15K models
 * 
 * @module ingestion/adapters/replicate-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS, RateLimitExceededError } from './base-adapter.js';

const REPLICATE_API_BASE = 'https://api.replicate.com/v1';
const DETAIL_CONCURRENCY = 5; // V28: bound per-model detail/README fan-out

/**
 * Replicate Adapter Implementation
 */
export class ReplicateAdapter extends BaseAdapter {
    constructor() {
        super('replicate');
        this.entityTypes = ['model'];
        this.apiToken = process.env.REPLICATE_API_TOKEN;
    }

    /**
     * Get auth headers
     */
    getHeaders() {
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Free2AITools/1.0'
        };
        if (this.apiToken) {
            headers['Authorization'] = `Bearer ${this.apiToken}`;
        }
        return headers;
    }

    /**
     * Fetch models from Replicate API
     * @param {Object} options
     * @param {number} options.limit - Number of models to fetch (default: 5000)
     */
    async fetch(options = {}) {
        const { limit = 5000, onBatch } = options;

        console.log(`📥 [Replicate] Fetching up to ${limit} models...`);

        if (!this.apiToken) {
            console.warn('⚠️ [Replicate] No REPLICATE_API_TOKEN, using public API (may be limited)');
        }

        const allModels = [];
        let cursor = null;
        let page = 1;
        // V28 hang-fix: loop-scoped 429 attempt counter (the cursor does NOT advance on
        // a 429 — same request retried — so the old flat 30s+continue spun forever on a
        // persistent header-less 429). Drives handleRateLimit() escalation + breaker;
        // reset to 0 after each successful page; breaker breaks the loop gracefully.
        let attempt = 0;

        while ((onBatch ? true : allModels.length < limit)) {
            const url = cursor
                ? `${REPLICATE_API_BASE}/models?cursor=${encodeURIComponent(cursor)}`
                : `${REPLICATE_API_BASE}/models`;

            try {
                console.log(`   Fetching page ${page}...`);
                const response = await this.fetchWithTimeout(url, { headers: this.getHeaders() });

                if (!response.ok) {
                    if (response.status === 429) {
                        // V28: escalate by attempt + honor headers; breaker throws at attempt>=6.
                        await this.handleRateLimit(response, attempt++);
                        continue;
                    }
                    throw new Error(`Replicate API error: ${response.status}`);
                }

                // V28: page fetched OK → reset the 429 escalation counter.
                attempt = 0;

                const data = await response.json();
                const models = data.results || [];

                if (models.length === 0) break;

                // Filter safe models
                const safeModels = models.filter(m => this.isSafeForWork(m));

                // Secondary request logic: fetch full README for each safe model.
                // V28 efficiency: bound concurrency (was fully sequential — ~5000 serial
                // calls at limit=5000). Process in windows of DETAIL_CONCURRENCY with a
                // small inter-window delay so we stay polite without serializing.
                console.log(`   📝 Fetching deep README context for ${safeModels.length} models...`);
                await this.enrichReadmes(safeModels);

                if (onBatch) {
                    await onBatch(safeModels);
                } else {
                    allModels.push(...safeModels);
                }

                console.log(`   📦 Got ${safeModels.length}/${models.length} models (total: ${onBatch ? 'Streaming' : allModels.length})`);

                // Check for next page
                cursor = data.next ? new URL(data.next).searchParams.get('cursor') : null;
                if (!cursor || (!onBatch && allModels.length >= limit)) break;

                page++;
                await this.delay(1000); // Rate limiting

            } catch (error) {
                // V28: breaker tripped → break-the-loop gracefully (keep what we have).
                if (error instanceof RateLimitExceededError) {
                    console.warn(`   🛑 [Replicate] rate-limit breaker tripped — finishing early with ${onBatch ? 'streamed' : allModels.length} models.`);
                } else {
                    console.error(`   ❌ Error: ${error.message}`);
                }
                break;
            }
        }

        console.log(`✅ [Replicate] ${onBatch ? 'Streaming' : 'Fetched ' + allModels.length + ' models'} complete`);
        return onBatch ? [] : allModels.slice(0, limit);
    }

    /**
     * V28: Bound-concurrency README enrichment for a page of safe models.
     * Was fully sequential (one HTTP round-trip per model, blocking) — at limit=5000
     * that is ~5000 serial calls. Process in windows of DETAIL_CONCURRENCY via
     * Promise.all, with a small inter-window delay to stay polite. Each fetch is
     * bounded by fetchWithTimeout; a per-model failure only drops that model's README
     * (honest fallback: normalize() uses description). Mutates models in place.
     * @param {Object[]} models - safe models for this page
     */
    async enrichReadmes(models) {
        for (let i = 0; i < models.length; i += DETAIL_CONCURRENCY) {
            const window = models.slice(i, i + DETAIL_CONCURRENCY);
            await Promise.all(window.map(async (model) => {
                try {
                    const detailUrl = `${REPLICATE_API_BASE}/models/${model.owner}/${model.name}`;
                    const detailRes = await this.fetchWithTimeout(detailUrl, { headers: this.getHeaders() }, 5000);
                    if (detailRes.ok) {
                        const detailData = await detailRes.json();
                        const rawReadme = detailData.readme || null;
                        if (rawReadme) {
                            // V19.5 Hardening: Relaxed Truncation (250KB)
                            model.readme = rawReadme.length > 250000
                                ? rawReadme.substring(0, 250000) + '\n\n[Content truncated for memory safety...]'
                                : rawReadme;
                        }
                    }
                } catch (e) {
                    console.warn('[Replicate] README fetch failed for ' + (model?.id || 'unknown') + ': ' + e.message);
                }
            }));
            if (i + DETAIL_CONCURRENCY < models.length) await this.delay(200);
        }
    }

    /**
     * Check if model is safe for work
     */
    isSafeForWork(model) {
        const name = (model.name || '').toLowerCase();
        const description = (model.description || '').toLowerCase();
        const text = `${name} ${description}`;

        return !NSFW_KEYWORDS.some(keyword => text.includes(keyword));
    }

    /**
     * Normalize Replicate model to UnifiedEntity
     */
    normalize(model) {
        const modelId = `${model.owner}/${model.name}`;

        const entity = {
            id: this.generateId(model.owner, model.name, 'model'),
            source: 'replicate',
            // V28 (PR-D): was `entity_type` (no top-level `type` key), leaving
            // entity.type undefined on the row. Every other adapter keys this `type`.
            type: 'model',
            name: model.name,
            author: model.owner,
            description: model.description || '',
            body_content: model.readme || model.description || '',
            source_url: `https://replicate.com/${modelId}`,

            // Metrics
            downloads: model.run_count || 0,
            likes: 0, // Replicate doesn't expose likes

            // Metadata
            tags: this.extractTags(model),
            license: model.license_url ? 'custom' : null,
            primary_category: this.inferCategory(model),
            raw_image_url: model.cover_image_url || null,

            // Technical
            params_billions: this.extractParamsFromName(model.name),
            has_gguf: false,

            // Timestamps
            created_at: model.created_at,
            last_modified: model.latest_version?.created_at || model.created_at,

            // Full metadata
            meta_json: {
                replicate_url: model.url,
                github_url: model.github_url,
                paper_url: model.paper_url,
                license_url: model.license_url,
                visibility: model.visibility,
                latest_version: model.latest_version?.id,
                run_count: model.run_count,
                cover_image_url: model.cover_image_url
            },

            // System fields (calculated below)
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
     * Extract tags from model
     */
    extractTags(model) {
        const tags = [];

        // Add visibility as tag
        if (model.visibility) tags.push(model.visibility);

        // Extract from description keywords
        const desc = (model.description || '').toLowerCase();
        const keywords = ['image', 'text', 'audio', 'video', 'llm', 'diffusion', 'gan'];
        keywords.forEach(kw => {
            if (desc.includes(kw)) tags.push(kw);
        });

        return [...new Set(tags)];
    }

    /**
     * Infer category from model
     */
    inferCategory(model) {
        const desc = (model.description || '').toLowerCase();
        const name = (model.name || '').toLowerCase();
        const text = `${name} ${desc}`;

        if (text.includes('image') || text.includes('diffusion') || text.includes('stable')) {
            return 'text-to-image';
        }
        if (text.includes('llm') || text.includes('language') || text.includes('chat')) {
            return 'text-generation';
        }
        if (text.includes('audio') || text.includes('speech') || text.includes('music')) {
            return 'audio';
        }
        if (text.includes('video')) {
            return 'video';
        }

        return 'other';
    }

    /**
     * Extract params_billions from model name using regex
     * Per EXEC-MASTER-V2.1 P0.5: Replicate params parsing
     * Matches patterns: 7b, 70b, 1.5b, 405b, etc.
     */
    extractParamsFromName(name) {
        if (!name) return null;

        // Match patterns like: 7b, 70b, 1.5b, 405b, 8x7b (for MoE models)
        const patterns = [
            /(\d+(?:\.\d+)?)[bB](?![a-zA-Z])/,  // Simple: 7b, 70b, 1.5b
            /(\d+)x(\d+)[bB]/,                   // MoE: 8x7b = 56b
        ];

        const lowerName = name.toLowerCase();

        // Try MoE pattern first (8x7b)
        const moeMatch = lowerName.match(patterns[1]);
        if (moeMatch) {
            const total = parseInt(moeMatch[1]) * parseInt(moeMatch[2]);
            return total;
        }

        // Try simple pattern
        const simpleMatch = lowerName.match(patterns[0]);
        if (simpleMatch) {
            return parseFloat(simpleMatch[1]);
        }

        return null;
    }
}

export default ReplicateAdapter;
