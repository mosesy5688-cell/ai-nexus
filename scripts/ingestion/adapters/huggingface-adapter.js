/**
 * HuggingFace Adapter
 * 
 * B.1 CES Refactor: Core adapter with fetch methods
 * Imports from: hf-strategies.js, hf-utils.js, hf-normalizer.js
 * 
 * @module ingestion/adapters/huggingface-adapter
 */

import { BaseAdapter } from './base-adapter.js';
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

        if (limit > 1000) {
            console.log(`📥 [HuggingFace] Using MULTI-STRATEGY for ${limit} models...`);
            const result = await this.fetchMultiStrategy({
                limitPerStrategy: Math.min(1000, Math.ceil(limit / 4)),
                strategyIndices: [0, 1, 2, 3], full
            });
            return result.models;
        }

        console.log(`📥 [HuggingFace] Fetching top ${limit} models by ${sort}...`);
        const response = await fetch(`${HF_API_BASE}/models?sort=${sort}&direction=${direction}&limit=${limit}`, { headers: this.getHeaders() });
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
            const batchResults = await Promise.all(batch.map(m => this.fetchFullModel(m.modelId || m.id)));
            fullModels.push(...batchResults.filter(m => m !== null));
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
                const response = await fetch(`${HF_API_BASE}/models?sort=${strategy.sort}&direction=${strategy.direction}&limit=${limitPerStrategy}`, { headers: this.getHeaders() });
                if (!response.ok) { console.warn(`   ⚠️ API error: ${response.status}`); continue; }

                const models = await response.json();
                const newModels = models.filter(m => { const id = m.modelId || m.id; if (collectedIds.has(id)) return false; collectedIds.add(id); return true; });
                console.log(`   🆕 ${newModels.length} unique models`);

                if (full && newModels.length > 0) {
                    for (let i = 0; i < newModels.length; i += batchSize) {
                        const batch = newModels.slice(i, i + batchSize);
                        const batchResults = await Promise.all(batch.map(m => this.fetchFullModel(m.modelId || m.id)));
                        allModels.push(...batchResults.filter(m => m !== null));
                        if (i + batchSize < newModels.length) await delay(delayMs);
                    }
                } else { allModels.push(...newModels); }
                await delay(2000);
            } catch (error) { console.error(`   ❌ Strategy failed: ${error.message}`); }
        }
        console.log(`\n✅ [HuggingFace] Multi-strategy total: ${allModels.length} unique models`);
        return { models: allModels, collectedIds: Array.from(collectedIds), stats: { strategies_used: strategyIndices.length, unique_models: allModels.length } };
    }

    async fetchByPipelineTags(options = {}) {
        const { limitPerTag = 5000, tags = PIPELINE_TAGS, existingIds = new Set(), full = false } = options;
        const collectedIds = new Set(existingIds);
        const allModels = [];

        for (const tag of tags) {
            console.log(`\n📥 [HuggingFace] Pipeline tag: ${tag}`);
            try {
                const response = await fetch(`${HF_API_BASE}/models?filter=${tag}&sort=likes&direction=-1&limit=${limitPerTag}`, { headers: this.getHeaders() });
                if (!response.ok) { console.warn(`   ⚠️ API error: ${response.status}`); continue; }

                const models = await response.json();
                const newModels = models.filter(m => { const id = m.modelId || m.id; if (collectedIds.has(id)) return false; collectedIds.add(id); return true; });
                console.log(`   🆕 ${newModels.length} unique (${models.length} total)`);
                allModels.push(...newModels);
                await delay(1000);
            } catch (error) { console.error(`   ❌ Tag ${tag} failed: ${error.message}`); }
        }
        console.log(`\n✅ [HuggingFace] Pipeline tag collection: ${allModels.length} unique models`);
        return { models: allModels, collectedIds: Array.from(collectedIds) };
    }

    async fetchFullModel(modelId, retryCount = 0) {
        try {
            const [modelRes, readmeRes] = await Promise.all([
                fetch(`${HF_API_BASE}/models/${modelId}`, { headers: this.getHeaders() }),
                fetch(`${HF_RAW_BASE}/${modelId}/raw/main/README.md`, { headers: this.getHeaders() })
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
