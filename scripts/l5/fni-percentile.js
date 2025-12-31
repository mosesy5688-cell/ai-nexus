/**
 * L5 FNI Percentile Utilities
 * 
 * Phase 9: Calculate and assign FNI percentile badges
 * Extracted from fni-compute.js for CES compliance (Art 5.1)
 * 
 * @module l5/fni-percentile
 */

/**
 * Calculate percentile threshold at given percentage
 * @param {Array} sortedResults - Results sorted by FNI descending
 * @param {number} percentile - Percentile value (0.1, 1, 5, 10, 25)
 * @returns {number} FNI score at threshold
 */
export function getPercentileThreshold(sortedResults, percentile) {
    const idx = Math.floor(sortedResults.length * (percentile / 100));
    return sortedResults[idx]?.fni_score || 0;
}

/**
 * Calculate all percentile thresholds
 * @param {Array} results - Array of entities with fni_score
 * @returns {Object} Thresholds for top 0.1%, 1%, 5%, 10%, 25%
 */
export function calculatePercentileThresholds(results) {
    const sortedByFNI = [...results].sort((a, b) => b.fni_score - a.fni_score);

    return {
        top_0_1: getPercentileThreshold(sortedByFNI, 0.1),
        top_1: getPercentileThreshold(sortedByFNI, 1),
        top_5: getPercentileThreshold(sortedByFNI, 5),
        top_10: getPercentileThreshold(sortedByFNI, 10),
        top_25: getPercentileThreshold(sortedByFNI, 25)
    };
}

/**
 * Assign percentile badge to an entity based on rank
 * @param {number} rank - Entity rank (1-based)
 * @param {number} total - Total entities
 * @returns {string} Percentile badge
 */
export function assignPercentileBadge(rank, total) {
    const percentile = ((total - rank) / total) * 100;

    if (percentile >= 99.9) return 'top_0.1%';
    if (percentile >= 99) return 'top_1%';
    if (percentile >= 95) return 'top_5%';
    if (percentile >= 90) return 'top_10%';
    if (percentile >= 75) return 'top_25%';
    return 'top_50';
}

/**
 * Enrich results with percentile badges
 * @param {Array} results - Array of entities with fni_score
 * @returns {Array} Enriched results with fni_percentile field
 */
export function enrichWithPercentiles(results) {
    const sortedByFNI = [...results].sort((a, b) => b.fni_score - a.fni_score);

    return results.map(entity => {
        const rank = sortedByFNI.findIndex(e => e.id === entity.id) + 1;
        const fni_percentile = assignPercentileBadge(rank, results.length);
        return { ...entity, fni_percentile };
    });
}

/**
 * Log percentile thresholds to console
 * @param {Object} thresholds - Percentile thresholds object
 */
export function logPercentileThresholds(thresholds) {
    console.log(`📊 FNI Percentile Thresholds:`);
    console.log(`   Top 0.1%: ${thresholds.top_0_1}`);
    console.log(`   Top 1%:   ${thresholds.top_1}`);
    console.log(`   Top 5%:   ${thresholds.top_5}`);
    console.log(`   Top 10%:  ${thresholds.top_10}`);
    console.log(`   Top 25%:  ${thresholds.top_25}`);
}

export default {
    getPercentileThreshold,
    calculatePercentileThresholds,
    assignPercentileBadge,
    enrichWithPercentiles,
    logPercentileThresholds
};
