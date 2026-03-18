/**
 * Enhanced Data Service
 * Integrates KV caching and recommendations with existing data layer
 */

import { getModels } from './data';
import type { KVNamespace } from '@cloudflare/workers-types';
import {
    getCache,
    setCache,
    getModelsListKey,
    getRelatedModelsKey,
    CACHE_TTL
} from './cache-service.js';
import { findRelatedModels } from './recommendation-service.js';

/**
 * Get all models with optional KV caching
 * Falls back to direct fetch if KV unavailable
 */
export async function getModelsWithCache(kv?: KVNamespace) {
    if (!kv) {
        // No cache, direct fetch
        return await getModels();
    }

    const cacheKey = getModelsListKey();

    // Try cache first
    const cached = await getCache(kv, cacheKey);
    if (cached) {
        console.log('✅ Cache HIT: models list');
        return cached;
    }

    console.log('❌ Cache MISS: models list - fetching and caching');

    // Fetch from static JSON
    const models = await getModels();

    // Store in cache
    await setCache(kv, cacheKey, models, CACHE_TTL.HOT_MODELS);

    return models;
}

/**
 * Get related models for a target model with caching
 */
export async function getRelatedModels(
    modelId: string,
    kv?: KVNamespace,
    limit: number = 6
) {
    // Get all models (possibly cached)
    const allModels = kv ? await getModelsWithCache(kv) : await getModels();

    // Find target model
    const targetModel = allModels.find((m: any) => m.id === modelId);
    if (!targetModel) {
        console.warn(`Model not found: ${modelId}`);
        return [];
    }

    // If no KV, compute directly without caching
    if (!kv) {
        return findRelatedModels(targetModel, allModels, limit);
    }

    // Try cache
    const cacheKey = getRelatedModelsKey(modelId);
    const cached = await getCache(kv, cacheKey);
    if (cached) {
        console.log(`✅ Cache HIT: related models for ${modelId}`);
        return cached;
    }

    console.log(`❌ Cache MISS: related models for ${modelId} - computing`);

    // Compute related models
    const related = findRelatedModels(targetModel, allModels, limit);

    // Cache result
    await setCache(kv, cacheKey, related, CACHE_TTL.RELATED_MODELS);

    return related;
}

/**
 * Get a single model by ID with optional caching
 */
export async function getModelById(modelId: string, kv?: KVNamespace) {
    const allModels = kv ? await getModelsWithCache(kv) : await getModels();
    return allModels.find((m: any) => m.id === modelId);
}
