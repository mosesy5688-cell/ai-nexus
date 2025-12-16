/**
 * Related Models Similarity Algorithm
 * Per V5.2.1 Art 6.1 (3+ Internal Links)
 * 
 * Score = (Task Match * 0.5) + (FNI Similarity * 0.3) + (Popularity * 0.2)
 */

interface ModelEntity {
    id: string;
    slug?: string;
    name: string;
    author?: string;
    pipeline_tag?: string;
    base_model?: string;
    fni_score?: number;
    downloads?: number;
    likes?: number;
    cover_image_url?: string;
}

interface ScoredModel {
    model: ModelEntity;
    score: number;
}

/**
 * Get related models based on similarity scoring
 * @param current - The current model being viewed
 * @param allModels - Pool of models to compare against
 * @param limit - Maximum number of related models to return (default: 6)
 */
export function getRelatedModels(
    current: ModelEntity,
    allModels: ModelEntity[],
    limit: number = 6
): ModelEntity[] {
    if (!allModels?.length || !current) return [];

    const scored: ScoredModel[] = allModels
        .filter(m => m.id !== current.id)
        .map(m => {
            let score = 0;

            // 1. Task Match (Weight: 0.5) - Primary signal
            if (m.pipeline_tag && m.pipeline_tag === current.pipeline_tag) {
                score += 50;
            }

            // 1b. Base Model Match (Bonus)
            if (m.base_model && current.base_model && m.base_model === current.base_model) {
                score += 20;
            }

            // 2. FNI Similarity (Weight: 0.3) - Penalize large gaps
            const currentFni = current.fni_score || 0;
            const modelFni = m.fni_score || 0;
            const fniDiff = Math.abs(modelFni - currentFni);
            // Bonus for being within 30 points of each other
            score += Math.max(0, 30 - fniDiff);

            // 3. Popularity (Weight: 0.2) - Boost high quality models
            const downloads = m.downloads || 0;
            const popularity = Math.log10(downloads + 1);
            score += popularity * 2;

            return { model: m, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return scored.map(item => item.model);
}

/**
 * Lightweight version for client-side use (no heavy computation)
 * Simply filters by same pipeline_tag and takes top N by FNI
 */
export function getRelatedModelsLite(
    current: ModelEntity,
    allModels: ModelEntity[],
    limit: number = 5
): ModelEntity[] {
    if (!allModels?.length || !current) return [];

    return allModels
        .filter(m => m.id !== current.id && m.pipeline_tag === current.pipeline_tag)
        .sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0))
        .slice(0, limit);
}
