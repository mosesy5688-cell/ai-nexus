/**
 * V6.0.1 Model Enricher
 * Adds primary_category, category_status, and size_bucket to model data
 * 
 * Constitution V5.2.1 Art 6.1 - Category = Verifiable Fact Only
 * V6.0.1 Strategy: Only pipeline_tag = classified, no semantic inference
 * Semantic inference (tags/name) deferred to V6.1 L5 Analyst (Sidecar)
 */

import { CategoryId, CATEGORY_PRIORITY } from '../config/categories';
import { CATEGORY_MAP, PIPELINE_TO_CATEGORY } from '../config/category-mapping';
import { estimateVram } from './vram-estimator';

// ============================================================================
// Types
// ============================================================================

export type CategoryStatus = 'classified' | 'pending_classification';

export interface CategoryResult {
    category: CategoryId | null;
    confidence: 'high' | 'none';
    status: CategoryStatus;
}

export interface SizeResult {
    size_bucket: string;
    size_source: 'config' | 'name_inference' | 'unknown';
}

export interface EnrichedModel {
    primary_category: CategoryId | null;
    category_confidence: 'high' | 'none';
    category_status: CategoryStatus;
    size_bucket: string;
    size_source: 'config' | 'name_inference' | 'unknown';
}

// ============================================================================
// Category Assignment (V6.0.1 - Pure High-Confidence Only)
// ============================================================================

/**
 * V6.0.1 → V6.1 Enhanced Strategy:
 * - PRIMARY: pipeline_tag from HuggingFace API = classified (high confidence)
 * - FALLBACK: tags[] array matching known pipeline_tag values (medium confidence)
 * - NO semantic inference from name/description (deferred to future)
 * 
 * V6.1: Added tags fallback to improve coverage from 48% to 75%+
 */
export function assignCategory(model: any): CategoryResult {
    // Source 1: pipeline_tag from upstream API (highest confidence)
    if (model.pipeline_tag) {
        const category = PIPELINE_TO_CATEGORY[model.pipeline_tag];
        if (category) {
            return {
                category,
                confidence: 'high',
                status: 'classified'
            };
        }
        // pipeline_tag exists but not in our mapping (e.g., 'graph-learning')
        console.log(`[Enricher] Unknown pipeline_tag: ${model.pipeline_tag} for ${model.id}`);
    }

    // Source 2: V6.1 tags[] fallback - check if any tag matches known pipeline_tag
    if (model.tags && Array.isArray(model.tags)) {
        for (const tag of model.tags) {
            const tagLower = typeof tag === 'string' ? tag.toLowerCase() : tag;
            const category = PIPELINE_TO_CATEGORY[tagLower];
            if (category) {
                return {
                    category,
                    confidence: 'high', // tags from HF are still official metadata
                    status: 'classified'
                };
            }
        }
    }

    // No match found - pending classification
    return {
        category: null,
        confidence: 'none',
        status: 'pending_classification'
    };
}

// ============================================================================
// Size Estimation (unchanged - physical property, safe)
// ============================================================================

/**
 * Estimates model size bucket with source tracking
 * This is a physical property, not semantic - safe for V6.0
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

    // 2. Inference: Model name regex matching
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

// VRAM estimation imported from vram-estimator.ts for CES compliance

// ============================================================================
// Main Enricher
// ============================================================================

/**
 * Generate template-based SEO summary for entities
 * B.19: Fallback for entities that don't get AI-generated summaries
 * 
 * @param model - The model/entity data
 * @returns SEO-friendly summary string
 */
export function generateTemplateSummary(model: any): string {
    const name = model.name || 'AI Model';
    const author = model.author || 'Unknown';
    const type = model.type || 'model';
    const pipelineTag = model.pipeline_tag || '';
    const description = (model.description || '').substring(0, 150).trim();

    // Build template based on type
    let summary = '';

    switch (type) {
        case 'agent':
            summary = `${name} is an AI agent by ${author}`;
            if (pipelineTag) summary += ` for ${pipelineTag}`;
            break;
        case 'dataset':
            summary = `${name} is a dataset by ${author}`;
            if (pipelineTag) summary += ` for ${pipelineTag} tasks`;
            break;
        case 'paper':
            summary = `${name} is a research paper by ${author}`;
            break;
        default: // model
            summary = `${name} is an open-source AI model by ${author}`;
            if (pipelineTag) summary += ` for ${pipelineTag}`;
    }

    // Append truncated description if available
    if (description) {
        summary += `. ${description}`;
        if (description.length >= 150) summary += '...';
    }

    return summary.trim();
}

/**
 * V6.0.1 Enricher - Pure high-confidence classification
 * B.19: Now includes template summary generation
 * V12: Added VRAM estimation (params * 0.6 + 2)
 * Returns fields to be merged into model object
 */
export function enrichModel(model: any): EnrichedModel & { seo_summary: string; vram_estimated_gb: number | null; vram_source: string } {
    const categoryResult = assignCategory(model);
    const sizeResult = estimateSizeBucket(model);
    const seoSummary = generateTemplateSummary(model);
    const vramResult = estimateVram(model);

    return {
        primary_category: categoryResult.category,
        category_confidence: categoryResult.confidence,
        category_status: categoryResult.status,
        size_bucket: sizeResult.size_bucket,
        size_source: sizeResult.size_source,
        seo_summary: seoSummary,
        vram_estimated_gb: vramResult.vram_estimated_gb,
        vram_source: vramResult.vram_source
    };
}

