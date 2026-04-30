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
                offset: options.offset || 0, // V18.2.4: Support rotational offset
                onBatch: options.onBatch // V22.1: Pass streaming callback
            });
            // fetchByPipelineTags returns an object if onBatch is NOT used, 
            // but we've standardized it to return an array or empty array when streaming.
            return result.models || result;
        }

        // Use multi-strategy for medium limits (1000-10000)
        if (limit > 1000) {
            console.log(`📥 [HuggingFace] Using MULTI-STRATEGY for ${limit} models...`);
            const result = await this.fetchMultiStrategy({
                limitPerStrategy: Math.min(1000, Math.ceil(limit / 4)),
                strategyIndices: [0, 1, 2, 3], full,
                onBatch: options.onBatch // Stream callback
            });
            return result.models;
        }

        // V22.4: Comprehensive metadata expansion for industrial throughput
        const expandParams = [
            'author', 'cardData', 'config', 'createdAt', 'downloads',
            'likes', 'lastModified', 'pipeline_tag', 'safetensors', 'siblings', 'tags'
        ].map(e => `expand[]=${e}`).join('&');

        const skip = options.offset || 0;
        const url = `${HF_API_BASE}/models?sort=${sort}&direction=${direction}&limit=${limit}&skip=${skip}&${expandParams}`;
        const response = await fetch(url, { headers: this.getHeaders() });
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

                // V22.4: Leverage expanded metadata and skip detail fetch if possible
                return this.fetchFullModel(modelId, 0, m, options.registryManager);
            }));
            const validResults = batchResults.filter(m => m !== null && this.isSafeForWork(m));
            if (options.onBatch) {
                await options.onBatch(validResults);
            } else {
                fullModels.push(...validResults);
            }
            if ((i + batchSize) % 50 === 0) console.log(`   Progress: ${Math.min(i + batchSize, models.length)}/${models.length}`);
            if (i + batchSize < models.length) await delay(delayMs);
        }
        console.log(`✅ [HuggingFace] Fetched ${options.onBatch ? models.length : fullModels.length} models total`);
        return options.onBatch ? [] : fullModels;
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
                    const expandParams = [
                        'author', 'cardData', 'config', 'createdAt', 'downloads',
                        'likes', 'lastModified', 'pipeline_tag', 'safetensors', 'tags'
                    ].map(e => `expand[]=${e}`).join('&');

                    const url = `${HF_API_BASE}/models?sort=${strategy.sort}&direction=${strategy.direction}&limit=${limitPerStrategy}&${expandParams}`;
                    response = await fetch(url, { headers: this.getHeaders() });

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
                            // V22.4: Leverage expanded metadata
                            return this.fetchFullModel(modelId, 0, m, options.registryManager);
                        }));
                        const validResults = batchResults.filter(m => m !== null && this.isSafeForWork(m));
                        if (options.onBatch) {
                            await options.onBatch(validResults);
                        } else {
                            allModels.push(...validResults);
                        }
                        if (i + batchSize < newModels.length) await delay(delayMs);
                    }
                } else {
                    if (options.onBatch) {
                        await options.onBatch(newModels);
                    } else {
                        allModels.push(...newModels);
                    }
                }
                await delay(10000); // V14.5: Increased from 2s to 10s to allow rate limit window reset
            } catch (error) { console.error(`   ❌ Strategy failed: ${error.message}`); }
        }
        console.log(`\n✅ [HuggingFace] Multi-strategy total: ${allModels.length} unique models`);
        return { models: allModels, collectedIds: Array.from(collectedIds), stats: { strategies_used: strategyIndices.length, unique_models: allModels.length } };
    }

    async fetchByPipelineTags(options = {}) {
        const { limitPerTag = 5000, existingIds = new Set(), full = false, offset = 0, onBatch } = options;

        // V22.1 Sharding: Filter tags belonging to this shard
        const tags = PIPELINE_TAGS;

        console.log(`📥 [HuggingFace] Processing ${tags.length} tags...`);
        const collectedIds = new Set(existingIds);
        const allModels = [];
        const PAGE_SIZE = 1000; // HuggingFace API max per request

        for (const tag of tags) {
            // V22.8: Dual-sort strategy — 80% popular + 20% newest
            const sortStrategies = [
                { sort: 'likes', budget: Math.floor(limitPerTag * 0.8), label: 'popular' },
                { sort: 'lastModified', budget: Math.ceil(limitPerTag * 0.2), label: 'newest' }
            ];

            for (const strategy of sortStrategies) {
                console.log(`\n📥 [HuggingFace] ${tag} — ${strategy.label} (budget: ${strategy.budget})`);
                let tagModels = 0;
                let skip = strategy.sort === 'likes' ? offset : 0; // Only apply rotation offset to likes sort
                let hasMore = true;

                try {
                    // Paginate through all results for this tag+sort
                    while (hasMore && tagModels < strategy.budget) {
                        const batchLimit = Math.min(PAGE_SIZE, strategy.budget - tagModels);
                        const expandParams = [
                            'author', 'cardData', 'config', 'createdAt', 'downloads',
                            'likes', 'lastModified', 'pipeline_tag', 'safetensors', 'tags'
                        ].map(e => `expand[]=${e}`).join('&');

                        const url = `${HF_API_BASE}/models?filter=${tag}&sort=${strategy.sort}&direction=-1&limit=${batchLimit}&skip=${skip}&${expandParams}`;

                        const response = await fetch(url, { headers: this.getHeaders() });

                        if (!response.ok) {
                            if (response.status === 429) {
                                const backoff = calculateBackoff(Math.floor(skip / PAGE_SIZE));
                                console.log(`   ⚠️ Rate limited (429), backing off ${backoff}ms...`);
                                await delay(backoff);
                                continue; // Retry same request
                            }
                            // V22.8: 400 = HF API pagination ceiling (~4000-5000 offset)
                            if (response.status === 400) {
                                console.log(`   ⏭️ [${tag}] Pagination ceiling at skip=${skip}, switching...`);
                                hasMore = false;
                                break;
                            }
                            console.warn(`   ⚠️ API error: ${response.status}`);
                            break;
                        }

                        const models = await response.json();

                        if (models.length === 0) {
                            hasMore = false;
                            break;
                        }

                        // Filter duplicates (shared across both sorts)
                        const newModels = models.filter(m => {
                            const id = m.modelId || m.id;
                            if (collectedIds.has(id)) return false;
                            collectedIds.add(id);
                            return true;
                        });

                        // V2.1: Add NSFW filter
                        const safeModels = newModels.filter(m => this.isSafeForWork(m));

                        // V22.10: Data Richness Recovery (Zero-cost config extraction)
                        for (let m of safeModels) {
                            try {
                                if (!m.meta_json && (m.config || m.safetensors)) {
                                    const meta = buildMetaJson(m);
                                    if (meta) {
                                        m.meta_json = meta;
                                        if (meta.context_length) m.context_length = meta.context_length;
                                        if (meta.params_billions) m.params_billions = meta.params_billions;
                                    }
                                }
                            } catch (e) {
                                console.warn(`   ⚠️ Warning: Meta extraction failed for ${m.id}:`, e.message);
                            }
                        }

                        if (onBatch) {
                            await onBatch(safeModels);
                        } else {
                            allModels.push(...safeModels);
                        }

                        tagModels += models.length;
                        skip += models.length;

                        // Log progress for large fetches
                        if (tagModels >= 1000 && tagModels % 2000 < PAGE_SIZE) {
                            console.log(`   📦 Progress: ${tagModels} ${strategy.label} models fetched...`);
                        }

                        // Stop if we got less than requested (no more pages)
                        if (models.length < batchLimit) {
                            hasMore = false;
                        }

                        // Rate limit delay between pages
                        if (hasMore) await delay(500);
                    }

                    console.log(`   🆕 ${tag}/${strategy.label}: ${tagModels} fetched`);

                } catch (error) {
                    console.error(`   ❌ Tag ${tag}/${strategy.label} failed: ${error.message}`);
                }
            }
            await delay(1000); // Delay between tags
        }

        console.log(`\n✅ [HuggingFace] Pipeline tag collection: ${onBatch ? 'Streaming' : allModels.length} complete`);
        return onBatch ? { models: [], stats: { total: collectedIds.size } } : { models: allModels, stats: { total: allModels.length } };
    }

    async fetchFullModel(modelId, retryCount = 0, expandedData = null, registryManager = null) {
        try {
            // V22.4 Industrial Refit: Skip network if expandedData is fresh
            if (registryManager && expandedData && expandedData.lastModified) {
                const normId = this.generateId(null, modelId, 'model');
                const existing = registryManager.registry?.entities?.find(e => e.id === normId);

                // If the model hasn't changed since last seen, and we have it in registry, reuse it
                if (existing && new Date(existing.updated_at || 0) >= new Date(expandedData.lastModified)) {
                    // console.log(`   ⏭️  [HF] Skipping README fetch for ${modelId} (No change)`);

                    // Merge expanded metrics into existing entity for freshness
                    existing.popularity = expandedData.likes || existing.popularity;
                    existing.downloads = expandedData.downloads || existing.downloads;
                    existing.updated_at = expandedData.lastModified;
                    // Backfill context_length from architecture if missing
                    if (!existing.context_length && existing.architecture) {
                        const { CONTEXT_LENGTH_BY_ARCH } = await import('./hf-utils.js');
                        const archKey = (existing.architecture || '').toLowerCase().replace(/forlm$|forcausal.*/, '');
                        existing.context_length = CONTEXT_LENGTH_BY_ARCH[archKey] || null;
                    }
                    return existing;
                }
            }

            // If we have expandedData but it's newer (or no registry), we still need the README
            const [modelRes, readmeRes, configRes] = await Promise.all([
                // If we already have full expandedData, we can skip modelRes
                expandedData ? Promise.resolve({ ok: true, json: () => Promise.resolve(expandedData) }) :
                    fetch(`${HF_API_BASE}/models/${modelId}?expand[]=safetensors&expand[]=config`, { headers: this.getHeaders() }),
                fetch(`${HF_RAW_BASE}/${modelId}/raw/main/README.md`, { headers: this.getHeaders() }),
                fetch(`${HF_RAW_BASE}/${modelId}/raw/main/config.json`, { headers: this.getHeaders() })
            ]);

            if (modelRes.status === 429) {
                if (retryCount < RATE_LIMIT_CONFIG.maxRetries) {
                    const backoff = calculateBackoff(retryCount);
                    console.log(`   ⚠️ Rate limited for ${modelId}, backing off ${backoff}ms...`);
                    await delay(backoff);
                    return this.fetchFullModel(modelId, retryCount + 1, expandedData, registryManager);
                }
                console.warn(`   ❌ Max retries exceeded for ${modelId}`);
                return null;
            }
            if (!modelRes.ok) return null;

            const modelData = await modelRes.json();
            const rawReadme = readmeRes.ok ? await readmeRes.text() : '';

            // V19.5 Hardening: Relaxed Truncation (250KB)
            modelData.readme = rawReadme.length > 250000
                ? rawReadme.substring(0, 250000) + '\n\n[Content truncated for memory safety...]'
                : rawReadme;

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
