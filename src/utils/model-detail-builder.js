
/**
 * Model Detail Builder V5.1.2 (Refactored)
 * Constitution V4.9 Entity-First Architecture
 * Compliant with CES V5.1.2 Anti-Monolith (<250 lines)
 */

import { renderMarkdown } from './builders/markdown-utils.js';
import {
    getDisplayName,
    getBestDescription,
    parseBenchmarks,
    parseSpecs,
    buildFNI
} from './builders/model-getters.js';
import { buildSEOSchema, buildSEOMeta } from './builders/seo-builder.js';
import { fetchSimilarModels, fetchRelatedModels } from './builders/model-fetchers.js';
import { truncate } from './builders/parsing-utils.js';

// Re-export utilities for consumers
export { renderMarkdown, getDisplayName, getBestDescription };

// ============================================
// MAIN BUILDER (S-GRADE)
// ============================================

// Build complete model detail object
export async function buildModelDetail(model, locals) {
    if (!model) return null;

    // 1. Basic Extraction
    const benchmarks = parseBenchmarks(model);
    const specs = parseSpecs(model);
    const fni = buildFNI(model);

    // 2. Rich Content
    const descriptionMd = getBestDescription(model);
    const descriptionHtml = renderMarkdown(descriptionMd);
    const shortDescription = truncate(descriptionMd, 200);

    // 3. SEO
    const seoSchema = buildSEOSchema(model, benchmarks, specs);
    const seoMeta = buildSEOMeta(model, benchmarks, specs);

    // 4. Relations (Async)
    // In V5.1.2 we prefer empty arrays here and client-side filling if possible to keep SSR fast
    // const similar = await fetchSimilarModels(model, locals);
    const similar = [];

    return {
        // Core Identity
        id: model.id || model.umid,
        name: getDisplayName(model),
        slug: model.slug || model.id,

        // Data Objects
        benchmarks,
        specs,
        fni,

        // Content
        description: descriptionMd,
        descriptionHtml,
        shortDescription,

        // SEO
        seoSchema,
        seoMeta,

        // Graph / Relations
        similar,

        // Raw Access (if needed)
        _raw: model
    };
}

// ============================================
// COMPARE DELTA CALCULATION (S-GRADE)
// ============================================

// Calculate benchmark delta between two models
export function calculateBenchmarkDelta(modelA, modelB) {
    if (!modelA || !modelB) return null;

    // Helper to calc % diff
    const diff = (a, b) => {
        if (!b) return 0;
        return ((a - b) / b) * 100;
    };

    const bA = modelA.benchmarks;
    const bB = modelB.benchmarks;

    return {
        avg_score: diff(bA.avg_score, bB.avg_score),
        mmlu: diff(bA.mmlu, bB.mmlu),
        humaneval: diff(bA.humaneval, bB.humaneval)
    };
}
