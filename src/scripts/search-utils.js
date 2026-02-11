/**
 * V14.2 Search Utilities
 * Extracted for CES compliance (Art 5.1 Monolith Ban)
 * @module scripts/search-utils
 */

/**
 * Fuzzy match helper - allows word prefix and substring matching
 * @param {string} target - String to search in
 * @param {string} search - Query to search for
 * @returns {boolean} True if fuzzy match found
 */
export function fuzzyMatch(target, search) {
    if (!target) return false;
    const t = target.toLowerCase();
    if (t.includes(search)) return true;
    // Simple fuzzy: check if words start with query
    if (t.split(/[\s\-_]/).some(word => word.startsWith(search.slice(0, 3)))) return true;
    // Substring in any position for short queries
    if (search.length <= 3 && t.includes(search)) return true;
    return false;
}

/**
 * Score item based on field boost weights
 * V14.2 Boost: name:50, startsWith:30, tags:20, author:10, exact:100, FNI bonus
 * @param {object} item - Search index item {n, t, a, sc}
 * @param {string} query - Lowercase search query
 * @returns {number} Relevance score
 */
export function scoreItem(item, query) {
    let score = 0;
    if (fuzzyMatch(item.n, query)) score += 50;  // Name match = 50 points
    if (item.n?.toLowerCase().startsWith(query)) score += 30;  // Starts with = bonus
    if (fuzzyMatch(item.t, query)) score += 20;  // Tags match = 20 points
    if (fuzzyMatch(item.a, query)) score += 10;  // Author match = 10 points
    if (item.n?.toLowerCase() === query) score += 100;  // Exact match = max boost
    score += (item.sc || item.fni || 0) / 10;  // FNI score bonus
    return score;
}
