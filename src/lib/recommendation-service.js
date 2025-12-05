/**
 * Advanced Recommendation Service
 * Multi-factor similarity scoring for intelligent model recommendations
 */

/**
 * Calculate tag similarity using Jaccard index
 * @param {string} tags1 - First model's tags
 * @param {string} tags2 - Second model's tags
 * @returns {number} Similarity score (0-1)
 */
function calculateTagSimilarity(tags1, tags2) {
    if (!tags1 || !tags2) return 0;

    const set1 = new Set(tags1.toLowerCase().split(',').map(t => t.trim()).filter(t => t));
    const set2 = new Set(tags2.toLowerCase().split(',').map(t => t.trim()).filter(t => t));

    if (set1.size === 0 || set2.size === 0) return 0;

    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return union.size > 0 ? intersection.size / union.size : 0;
}

/**
 * Calculate category similarity
 * @param {string} cat1 - First category
 * @param {string} cat2 - Second category
 * @returns {number} Similarity score (0 or 1)
 */
function calculateCategorySimilarity(cat1, cat2) {
    if (!cat1 || !cat2) return 0;
    return cat1.toLowerCase() === cat2.toLowerCase() ? 1.0 : 0.0;
}

/**
 * Calculate author similarity
 * @param {string} author1 - First author
 * @param {string} author2 - Second author
 * @returns {number} Similarity score (0 or 1)
 */
function calculateAuthorSimilarity(author1, author2) {
    if (!author1 || !author2) return 0;
    return author1.toLowerCase() === author2.toLowerCase() ? 1.0 : 0.0;
}

/**
 * Calculate popularity similarity (normalized)
 * Models with similar popularity levels score higher
 * @param {number} likes1 - First model's likes
 * @param {number} likes2 - Second model's likes
 * @returns {number} Similarity score (0-1)
 */
function calculatePopularitySimilarity(likes1, likes2) {
    const l1 = likes1 || 0;
    const l2 = likes2 || 0;

    const maxLikes = Math.max(l1, l2);
    const minLikes = Math.min(l1, l2);

    if (maxLikes === 0) return 0.5; // Both unpopular
    return minLikes / maxLikes;
}

/**
 * Calculate temporal relevance
 * Favor recently created/updated models
 * @param {string} createdAt - Creation date
 * @returns {number} Relevance score (0-1)
 */
function calculateTemporalRelevance(createdAt) {
    if (!createdAt) return 0.5;

    try {
        const now = Date.now();
        const created = new Date(createdAt).getTime();
        const ageInDays = (now - created) / (1000 * 60 * 60 * 24);

        // Decay function: newer models score higher
        if (ageInDays < 30) return 1.0;       // Very recent
        if (ageInDays < 90) return 0.8;       // Recent
        if (ageInDays < 180) return 0.6;      // Moderate
        if (ageInDays < 365) return 0.4;      // Old
        return 0.3;                            // Very old
    } catch (error) {
        return 0.5;
    }
}

/**
 * Calculate comprehensive similarity score
 * @param {Object} model1 - Target model
 * @param {Object} model2 - Candidate model
 * @returns {Object} Score and breakdown
 */
export function calculateSimilarityScore(model1, model2) {
    // Weighted factors (total = 1.0)
    const weights = {
        tags: 0.40,        // Most important - content similarity
        category: 0.25,    // Important - same type
        author: 0.15,      // Moderate - same creator
        popularity: 0.10,  // Minor - similar level
        temporal: 0.10     // Minor - recency boost
    };

    const scores = {
        tags: calculateTagSimilarity(model1.tags, model2.tags),
        category: calculateCategorySimilarity(model1.pipeline_tag, model2.pipeline_tag),
        author: calculateAuthorSimilarity(model1.author, model2.author),
        popularity: calculatePopularitySimilarity(model1.likes, model2.likes),
        temporal: calculateTemporalRelevance(model2.created_at)
    };

    // Calculate weighted total score
    const totalScore = Object.keys(weights).reduce((sum, key) => {
        return sum + (weights[key] * scores[key]);
    }, 0);

    return {
        score: totalScore,
        breakdown: scores,
        weights
    };
}

/**
 * Find related models using enhanced algorithm
 * @param {Object} targetModel - The reference model
 * @param {Array} allModels - All available models
 * @param {number} limit - Maximum results to return
 * @returns {Array} Related models with similarity scores
 */
export function findRelatedModels(targetModel, allModels, limit = 6) {
    if (!targetModel || !allModels || allModels.length === 0) {
        return [];
    }

    const related = allModels
        .filter(m => m.id !== targetModel.id)  // Exclude self
        .map(model => {
            const similarity = calculateSimilarityScore(targetModel, model);
            return {
                ...model,
                similarity_score: similarity.score,
                similarity_breakdown: similarity.breakdown
            };
        })
        .filter(m => m.similarity_score > 0.2)  // Minimum threshold (20%)
        .sort((a, b) => b.similarity_score - a.similarity_score)
        .slice(0, limit);

    return related;
}

/**
 * Get recommendation reasons (for UI display)
 * @param {Object} similarityBreakdown - Breakdown from calculateSimilarityScore
 * @returns {Array<string>} Human-readable reasons
 */
export function getRecommendationReasons(similarityBreakdown) {
    const reasons = [];

    if (similarityBreakdown.tags > 0.5) {
        reasons.push('Similar tags');
    }

    if (similarityBreakdown.category === 1.0) {
        reasons.push('Same category');
    }

    if (similarityBreakdown.author === 1.0) {
        reasons.push('Same author');
    }

    if (similarityBreakdown.popularity > 0.7) {
        reasons.push('Similar popularity');
    }

    if (similarityBreakdown.temporal > 0.8) {
        reasons.push('Recently updated');
    }

    return reasons.length > 0 ? reasons : ['Related content'];
}
