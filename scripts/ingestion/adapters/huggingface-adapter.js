/**
 * HuggingFace Adapter
 * 
 * B.1 CES Refactor: Core adapter with fetch methods
 * Imports from: hf-strategies.js, hf-utils.js, hf-normalizer.js
 * 
 * V2.1: Added NSFW filter at fetch level
 * 
 * @module ingestion/adapters/huggingface-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';
import { HF_API_BASE, HF_RAW_BASE, COLLECTION_STRATEGIES, PIPELINE_TAGS, RATE_LIMIT_CONFIG, calculateBackoff } from './hf-strategies.js';
import { parseModelId, inferType, normalizeTags, buildMetaJson, detectGGUF, extractAssets, delay } from './hf-utils.js';
import { normalizeModel, normalizeSpace, buildSpaceMetaJson, extractSpaceAssets } from './hf-normalizer.js';

/**
 * HuggingFace Adapter Implementation
 * V4.1: Added HF_TOKEN support and rate limiting
 * V4.3.1: Added multi-strategy collection
 * B.1: CES Refactored into modular files
 */
export class HuggingFaceAdapter extends BaseAdapter {
    constructor() {
        super('huggingface');
        this.entityTypes = ['model', 'dataset', 'space'];
        this.hfToken = process.env.HF_TOKEN || null;
    }

    getHeaders() {
        const headers = { 'Accept': 'application/json', 'User-Agent': 'Free2AITools/1.0' };
        if (this.hfToken) headers['Authorization'] = `Bearer ${this.hfToken}`;
        return headers;
    }

    async fetch(options = {}) {
        const { limit = 500, sort = 'likes', direction = -1, full = true } = options;

        // B.1: Use pipeline tags for large expansions (150K+)
        if (limit >= 10000) {
            console.log(`📥 [HuggingFace] Using PIPELINE TAGS for ${limit}+ models (B.1 expansion)...`);
            const result = await this.fetchByPipelineTags({
                limitPerTag: Math.ceil(limit / 21),  // Distribute across 21 tags
                full: false,  // Skip full details for speed
                offset: options.offset || 0 // V18.2.4: Support rotational offset
            });
            return result.models;
        }

        // Use multi-strategy for medium limits (1000-10000)
        if (limit > 1000) {
            console.log(`📥 [HuggingFace] Using MULTI-STRATEGY for ${limit} models...`);
            const result = await this.fetchMultiStrategy({
                limitPerStrategy: Math.min(1000, Math.ceil(limit / 4)),
                strategyIndices: [0, 1, 2, 3], full
            });
            return result.models;
        }

        console.log(`📥 [HuggingFace] Fetching top ${limit} models (offset: ${options.offset || 0}) by ${sort}...`);
        // V6.4: Add expand params for safetensors (params_billions) and config (context_length, architecture)
        // V18.2.4: Respect rotation offset
        const skip = options.offset || 0;
        const response = await fetch(`${HF_API_BASE}/models?sort=${sort}&direction=${direction}&limit=${limit}&skip=${skip}&expand[]=safetensors&expand[]=config`, { headers: this.getHeaders() });
        if (!response.ok) throw new Error(`HuggingFace API error: ${response.status}`);

        const models = await response.json();
        console.log(`📦 [HuggingFace] Got ${models.length} models from list`);
        if (!full) return models;

        console.log(`🔄 [HuggingFace] Fetching full details with rate limiting...`);
        const batchSize = this.hfToken ? RATE_LIMIT_CONFIG.batchSizeAuthenticated : RATE_LIMIT_CONFIG.batchSizeUnauthenticated;
        const delayMs = this.hfToken ? RATE_LIMIT_CONFIG.delayMsAuthenticated : RATE_LIMIT_CONFIG.delayMsUnauthenticated;

        const fullModels = [];
        for (let i = 0; i < models.length; i += batchSize) {
            const batch = models.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(m => {
                const modelId = m.modelId || m.id;
                // V18.2.4: Pre-comparison optimization
                if (options.registryManager) {
                    const normId = this.generateId(null, modelId, 'model');
                    const existing = options.registryManager.registry.entities.find(e => e.id === normId);
                    if (existing && m.lastModified && new Date(existing._last_seen || 0) > new Date(m.lastModified)) {
                        console.log(`   ⏭️ Skipping detail fetch for ${modelId} (No change)`);
                        return existing;
                    }
                }
                return this.fetchFullModel(modelId);
            }));
            fullModels.push(...batchResults.filter(m => m !== null && this.isSafeForWork(m)));
            if ((i + batchSize) % 50 === 0) console.log(`   Progress: ${Math.min(i + batchSize, models.length)}/${models.length}`);
            if (i + batchSize < models.length) await delay(delayMs);
        }
        console.log(`✅ [HuggingFace] Fetched ${fullModels.length} complete models`);
        return fullModels;
    }

    async fetchMultiStrategy(options = {}) {
        const { limitPerStrategy = 1000, strategyIndices = [0, 1, 2, 3], existingIds = new Set(), full = true } = options;
        const collectedIds = new Set(existingIds);
        const allModels = [];
        const batchSize = this.hfToken ? RATE_LIMIT_CONFIG.batchSizeAuthenticated : RATE_LIMIT_CONFIG.batchSizeUnauthenticated;
        const delayMs = this.hfToken ? RATE_LIMIT_CONFIG.delayMsAuthenticated : RATE_LIMIT_CONFIG.delayMsUnauthenticated;

        for (const strategyIndex of strategyIndices) {
            if (strategyIndex >= COLLECTION_STRATEGIES.length) continue;
            const strategy = COLLECTION_STRATEGIES[strategyIndex];
            console.log(`\n📥 [HuggingFace] Strategy ${strategyIndex + 1}/4: ${strategy.name}`);

            try {
                // V6.4: Add expand params for safetensors (params_billions) and config (context_length, architecture)
                let response;
                const maxRetries = 3;

                for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
                    response = await fetch(`${HF_API_BASE}/models?sort=${strategy.sort}&direction=${strategy.direction}&limit=${limitPerStrategy}&expand[]=safetensors&expand[]=config`, { headers: this.getHeaders() });

                    if (response.status === 429) {
                        const backoff = calculateBackoff(retryCount + 1);
                        console.log(`   ⚠️ Rate limited (429), retry ${retryCount + 1}/${maxRetries} after ${backoff}ms...`);
                        await delay(backoff);
                        continue;
                    }
                    break; // Success or other non-429 error
                }

                if (!response || !response.ok) { console.warn(`   ⚠️ API error: ${response?.status || 'unknown'}`); continue; }

                const models = await response.json();
                const newModels = models.filter(m => { const id = m.modelId || m.id; if (collectedIds.has(id)) return false; collectedIds.add(id); return true; });
                console.log(`   🆕 ${newModels.length} unique models`);

                if (full && newModels.length > 0) {
                    for (let i = 0; i < newModels.length; i += batchSize) {
                        const batch = newModels.slice(i, i + batchSize);
                        const batchResults = await Promise.all(batch.map(m => {
                            const modelId = m.modelId || m.id;
                            // V18.2.4: Pre-comparison optimization
                            if (options.registryManager) {
                                const normId = this.generateId(null, modelId, 'model');
                                const existing = options.registryManager.registry.entities.find(e => e.id === normId);
                                if (existing && m.lastModified && new Date(existing._last_seen || 0) > new Date(m.lastModified)) {
                                    return existing;
                                }
                            }
                            return this.fetchFullModel(modelId);
                        }));
                        allModels.push(...batchResults.filter(m => m !== null && this.isSafeForWork(m)));
                        if (i + batchSize < newModels.length) await delay(delayMs);
                    }
                } else { allModels.push(...newModels); }
                await delay(10000); // V14.5: Increased from 2s to 10s to allow rate limit window reset
            } catch (error) { console.error(`   ❌ Strategy failed: ${error.message}`); }
        }
        console.log(`\n✅ [HuggingFace] Multi-strategy total: ${allModels.length} unique models`);
        return { models: allModels, collectedIds: Array.from(collectedIds), stats: { strategies_used: strategyIndices.length, unique_models: allModels.length } };
    }

    async fetchByPipelineTags(options = {}) {
        const { limitPerTag = 5000, tags = PIPELINE_TAGS, existingIds = new Set(), full = false, offset = 0 } = options;
        const collectedIds = new Set(existingIds);
        const allModels = [];
        const PAGE_SIZE = 1000; // HuggingFace API max per request

        for (const tag of tags) {
            console.log(`\n📥 [HuggingFace] Pipeline tag: ${tag} (Start Offset: ${offset})`);
            let tagModels = 0;
            let skip = offset; // V18.2.4: Start from rotation offset
            let hasMore = true;

            try {
                // Paginate through all results for this tag
                while (hasMore && tagModels < limitPerTag) {
                    const batchLimit = Math.min(PAGE_SIZE, limitPerTag - tagModels);
                    // V6.4: Add expand params for safetensors (params_billions) and config (context_length, architecture)
                    const url = `${HF_API_BASE}/models?filter=${tag}&sort=likes&direction=-1&limit=${batchLimit}&skip=${skip}&expand[]=safetensors&expand[]=config`;

                    const response = await fetch(url, { headers: this.getHeaders() });

                    if (!response.ok) {
                        if (response.status === 429) {
                            const backoff = calculateBackoff(Math.floor(skip / PAGE_SIZE));
                            console.log(`   ⚠️ Rate limited (429), backing off ${backoff}ms...`);
                            await delay(backoff);
                            continue; // Retry same request
                        }
                        console.warn(`   ⚠️ API error: ${response.status}`);
                        break;
                    }

                    const models = await response.json();

                    if (models.length === 0) {
                        hasMore = false;
                        break;
                    }

                    // Filter duplicates
                    const newModels = models.filter(m => {
                        const id = m.modelId || m.id;
                        if (collectedIds.has(id)) return false;
                        collectedIds.add(id);
                        return true;
                    });

                    // V2.1: Add NSFW filter
                    const safeModels = newModels.filter(m => this.isSafeForWork(m));
                    allModels.push(...safeModels);
                    tagModels += models.length;
                    skip += models.length;

                    // Log progress for large fetches
                    if (tagModels >= 1000 && tagModels % 2000 < PAGE_SIZE) {
                        console.log(`   📦 Progress: ${tagModels} models fetched...`);
                    }

                    // Stop if we got less than requested (no more pages)
                    if (models.length < batchLimit) {
                        hasMore = false;
                    }

                    // Rate limit delay between pages
                    if (hasMore) await delay(500);
                }

                console.log(`   🆕 ${tagModels} fetched, ${allModels.length - (allModels.length - tagModels)} unique added`);
                await delay(1000); // Delay between tags

            } catch (error) {
                console.error(`   ❌ Tag ${tag} failed: ${error.message}`);
            }
        }

        console.log(`\n✅ [HuggingFace] Pipeline tag collection: ${allModels.length} unique models`);
        return { models: allModels, collectedIds: Array.from(collectedIds) };
    }

    async fetchFullModel(modelId, retryCount = 0) {
        try {
            // V6.4: Fetch config.json for params_billions, context_length, architecture
            const [modelRes, readmeRes, configRes] = await Promise.all([
                fetch(`${HF_API_BASE}/models/${modelId}?expand[]=safetensors&expand[]=config`, { headers: this.getHeaders() }),
                fetch(`${HF_RAW_BASE}/${modelId}/raw/main/README.md`, { headers: this.getHeaders() }),
                fetch(`${HF_RAW_BASE}/${modelId}/raw/main/config.json`, { headers: this.getHeaders() })
            ]);

            if (modelRes.status === 429) {
                if (retryCount < RATE_LIMIT_CONFIG.maxRetries) {
                    const backoff = calculateBackoff(retryCount);
                    console.log(`   ⚠️ Rate limited for ${modelId}, backing off ${backoff}ms...`);
                    await delay(backoff);
                    return this.fetchFullModel(modelId, retryCount + 1);
                }
                console.warn(`   ❌ Max retries exceeded for ${modelId}`);
                return null;
            }
            if (!modelRes.ok) return null;

            const modelData = await modelRes.json();
            modelData.readme = readmeRes.ok ? await readmeRes.text() : '';

            // V6.4: Merge config.json data for params extraction
            if (configRes.ok) {
                try {
                    const configData = await configRes.json();
                    modelData.config = configData;
                } catch (e) {
                    // config.json may not be valid JSON, ignore
                }
            }

            return this.normalize(modelData);
        } catch (error) {
            console.warn(`   ❌ Error fetching ${modelId}: ${error.message}`);
            return null;
        }
    }

    normalize(raw) { return normalizeModel(raw, this); }
    normalizeSpace(raw) { return normalizeSpace(raw, this); }

    // Expose utility functions as instance methods for compatibility
    parseModelId(modelId) { return parseModelId(modelId); }
    inferType(raw) { return inferType(raw); }
    normalizeTags(tags) { return normalizeTags(tags); }
    buildMetaJson(raw) { return buildMetaJson(raw); }
    buildSpaceMetaJson(raw) { return buildSpaceMetaJson(raw); }
    detectGGUF(raw) { return detectGGUF(raw); }
    extractAssets(raw) { return extractAssets(raw); }
    extractSpaceAssets(raw) { return extractSpaceAssets(raw); }
    delay(ms) { return delay(ms); }

    /**
     * V2.1: Check if model is safe for work (NSFW filter)
     * Constitutional: Uses NSFW_KEYWORDS whitelist, no inference
     */
    isSafeForWork(model) {
        const name = model.modelId || model.id || '';
        const text = `${name} ${model.cardData?.tags?.join(' ') || ''}`.toLowerCase();
        return !NSFW_KEYWORDS.some(kw => text.includes(kw));
    }

    // Space fetch methods
    async fetchSpaces(options = {}) {
        const { limit = 200, sort = 'likes', full = true } = options;
        console.log(`📥 [HuggingFace] Fetching top ${limit} spaces...`);
        const response = await fetch(`${HF_API_BASE}/spaces?sort=${sort}&direction=-1&limit=${limit}`, { headers: this.getHeaders() });
        if (!response.ok) throw new Error(`HuggingFace API error: ${response.status}`);
        const spaces = await response.json();
        if (!full) return spaces;

        const fullSpaces = [];
        for (const space of spaces) {
            const fullSpace = await this.fetchFullSpace(space.id);
            if (fullSpace) fullSpaces.push(fullSpace);
        }
        return fullSpaces;
    }

    async fetchFullSpace(spaceId) {
        try {
            const [spaceRes, readmeRes] = await Promise.all([
                fetch(`${HF_API_BASE}/spaces/${spaceId}`, { headers: this.getHeaders() }),
                fetch(`${HF_RAW_BASE}/spaces/${spaceId}/raw/main/README.md`, { headers: this.getHeaders() })
            ]);
            if (!spaceRes.ok) return null;
            const spaceData = await spaceRes.json();
            spaceData.readme = readmeRes.ok ? await readmeRes.text() : '';
            return this.normalizeSpace(spaceData);
        } catch (error) { return null; }
    }
}

export default HuggingFaceAdapter;
