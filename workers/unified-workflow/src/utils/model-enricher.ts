/**
 * V6.0 Model Enricher
 * Adds primary_category and size_bucket to model data
 * 
 * Constitution Annex A.2 - Category assignment with confidence tracking
 * Expert3 constraint: Fallback must not pollute rankings
 */

import { CategoryId, CATEGORY_PRIORITY } from '../config/categories';
import { CATEGORY_MAP, PIPELINE_TO_CATEGORY } from '../config/category-mapping';

// ============================================================================
// Types
// ============================================================================

export interface CategoryResult {
    category: CategoryId;
    confidence: 'high' | 'medium' | 'low';
}

export interface SizeResult {
    size_bucket: string;
    size_source: 'config' | 'name_inference' | 'unknown';
}

export interface EnrichedModel {
    primary_category: CategoryId;
    category_confidence: 'high' | 'medium' | 'low';
    size_bucket: string;
    size_source: 'config' | 'name_inference' | 'unknown';
    rank_penalty: number;
}

// ============================================================================
// Category Assignment
// ============================================================================

/**
 * Assigns primary category with confidence level
 * Strategy: Pipeline Tag (high) > Keyword Match (medium) > Fallback (low)
 */
export function assignCategory(model: any): CategoryResult {
    // 1. Pipeline Tag - most reliable (high confidence)
    if (model.pipeline_tag) {
        const category = PIPELINE_TO_CATEGORY[model.pipeline_tag];
        if (category) {
            return { category, confidence: 'high' };
        }
    }

    // 2. Tags array keyword matching (medium confidence)
    const tags = (model.tags || []).map((t: string) => t.toLowerCase());

    // Text generation indicators
    if (tags.some((t: string) => ['llm', 'chat', 'instruct', 'gpt'].includes(t))) {
        return { category: 'text-generation', confidence: 'medium' };
    }

    // Vision/multimedia indicators
    if (tags.some((t: string) => ['diffusion', 'lora', 'sdxl', 'stable-diffusion'].includes(t))) {
        return { category: 'vision-multimedia', confidence: 'medium' };
    }

    // Knowledge/embedding indicators
    if (tags.some((t: string) => ['embedding', 'sentence-transformers', 'rag'].includes(t))) {
        return { category: 'knowledge-retrieval', confidence: 'medium' };
    }

    // 3. Fallback - lowest confidence, will receive rank penalty
    console.warn(`[CategoryFallback] No category match for: ${model.name || model.id}`);
    return { category: 'infrastructure-ops', confidence: 'low' };
}

// ============================================================================
// Size Estimation
// ============================================================================

/**
 * Estimates model size bucket with source tracking
 * Expert3 constraint: Must distinguish Estimated vs Confirmed
 */
export function estimateSizeBucket(model: any): SizeResult {
    // 1. Priority: Safetensors config (most reliable)
    const params = model.config?.num_parameters || model.safetensors?.total;
    if (params && typeof params === 'number') {
        return {
            size_bucket: bucketFromParams(params),
            size_source: 'config'
        };
    }

    // 2. Inference: Model name regex matching (Expert2 enhanced)
    const name = (model.name || model.id || '').toLowerCase();

    // MoE detection (e.g., 8x7b, 4x22b)
    const moeMatch = name.match(/(\d+)x(\d+)b/);
    if (moeMatch) {
        const total = parseInt(moeMatch[1]) * parseInt(moeMatch[2]);
        if (total >= 100) return { size_bucket: '>100B', size_source: 'name_inference' };
        if (total >= 30) return { size_bucket: '30-70B', size_source: 'name_inference' };
        return { size_bucket: '7-13B', size_source: 'name_inference' };
    }

    // Standard size patterns
    if (name.match(/\b(70|72|100|110|120|140|180|200)b\b/i)) {
        return { size_bucket: '>100B', size_source: 'name_inference' };
    }
    if (name.match(/\b(30|32|33|34|40|45)b\b/i)) {
        return { size_bucket: '30-70B', size_source: 'name_inference' };
    }
    if (name.match(/\b(7|8|9|10|11|12|13|14)b\b/i)) {
        return { size_bucket: '7-13B', size_source: 'name_inference' };
    }
    if (name.match(/\b[1-6]b\b/i)) {
        return { size_bucket: '<7B', size_source: 'name_inference' };
    }
    // Millions (e.g., 350m, 1.5b)
    if (name.match(/\b\d{2,3}m\b/i)) {
        return { size_bucket: '<7B', size_source: 'name_inference' };
    }

    return { size_bucket: 'Unknown', size_source: 'unknown' };
}

function bucketFromParams(params: number): string {
    const billions = params / 1e9;
    if (billions >= 100) return '>100B';
    if (billions >= 30) return '30-70B';
    if (billions >= 7) return '7-13B';
    return '<7B';
}

// ============================================================================
// Main Enricher
// ============================================================================

/**
 * Enriches a model with category and size information
 * Returns fields to be merged into model object
 */
export function enrichModel(model: any): EnrichedModel {
    const categoryResult = assignCategory(model);
    const sizeResult = estimateSizeBucket(model);

    // Expert3: Low confidence = 30% rank penalty
    const rankPenalty = categoryResult.confidence === 'low' ? 0.7 : 1.0;

    return {
        primary_category: categoryResult.category,
        category_confidence: categoryResult.confidence,
        size_bucket: sizeResult.size_bucket,
        size_source: sizeResult.size_source,
        rank_penalty: rankPenalty
    };
}
