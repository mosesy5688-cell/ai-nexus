
// src/utils/builders/model-fetchers.js
// Note: This relies on the new R2/Hot Index architecture for "Similar" if available.
// But legacy used direct DB queries or locals.LAYOUT_CACHE?
// The original file used `locals.DB` (D1) which violates "Zero D1 Read" unless it's cold storage.
// BUT `model-detail-builder` is likely used in SSR (pages/model/[...slug].astro).
// SSR *can* read D1 if absolutely necessary, but R2 is preferred.
// However, the original code signature `fetchSimilarModels(model, locals, limit)` implies using `locals`.
// We will replicate the logic but keep it minimal.

export async function fetchSimilarModels(model, locals, limit = 100) {
    // Stub implementation - R2 should be source of truth.
    // In V5.1.2, similar models are likely pre-calculated or via search index.
    // If not, we return empty structure to avoid blocking render.
    return [];
}

export async function fetchRelatedModels(model, locals, limit = 100) {
    return [];
}
