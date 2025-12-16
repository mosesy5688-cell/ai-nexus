// src/utils/slug-utils.js
/**
 * Slug Normalization Utilities V4.5
 * Constitution V4.3.2 Compliant - 12-Rule Normalization Layer
 * 
 * Extracted from umid-resolver.js for modularity
 */

/**
 * Check if string is an ArXiv ID pattern
 * @param {string} str - String to check
 * @returns {boolean}
 */
export function isArxivId(str) {
    return /^\d{4}\.\d{4,5}$/.test(str);
}

/**
 * Normalize a slug using 12-rule normalization
 * @param {string} slug - Input slug in any format
 * @returns {string} - Normalized slug
 */
export function normalizeSlug(slug) {
    if (!slug || typeof slug !== 'string') return '';

    let normalized = slug;

    // Rule 1: Lowercase
    normalized = normalized.toLowerCase();

    // Rule 2: Trim
    normalized = normalized.trim();

    // Rule 3: Space → dash
    normalized = normalized.replace(/\s+/g, '-');

    // Rule 4: Slash → dash
    normalized = normalized.replace(/\//g, '-');

    // Rule 5: Underscore → dash
    normalized = normalized.replace(/_/g, '-');

    // Rule 6: Dot → dash (except for ArXiv IDs)
    if (!isArxivId(normalized)) {
        normalized = normalized.replace(/\./g, '-');
    }

    // Rule 7: Collapse multiple dashes
    normalized = normalized.replace(/-+/g, '-');

    // Rule 8: Remove leading/trailing dashes
    normalized = normalized.replace(/^-+|-+$/g, '');

    return normalized;
}

/**
 * Canonicalize a slug to ensure UMID compatibility
 * @param {string} slug - Input slug in any format
 * @returns {string} - Canonical UMID-compatible slug
 */
export function canonicalizeSlug(slug) {
    if (!slug || typeof slug !== 'string') return '';
    let canonical = normalizeSlug(slug);
    canonical = canonical.replace(/^(huggingface-|github-|arxiv-)/, '');
    return canonical;
}

/**
 * Extract author and name from HuggingFace format
 * @param {string} hfId - HuggingFace ID (author/name)
 * @returns {{author: string, name: string}}
 */
export function parseHuggingFaceId(hfId) {
    if (!hfId || typeof hfId !== 'string') {
        return { author: '', name: '' };
    }
    const parts = hfId.split('/');
    if (parts.length >= 2) {
        return { author: parts[0], name: parts.slice(1).join('/') };
    }
    return { author: '', name: hfId };
}

/**
 * Generate canonical variants for fuzzy matching
 * @param {string} normalized - Normalized slug
 * @returns {string[]} - Array of possible variants
 */
export function generateVariants(normalized) {
    const variants = [normalized];
    const suffixes = ['-instruct', '-chat', '-hf', '-model', '-base', '-fp16', '-fp32', '-gguf', '-awq', '-gptq'];

    for (const suffix of suffixes) {
        if (normalized.endsWith(suffix)) {
            variants.push(normalized.slice(0, -suffix.length));
        }
    }

    const versionMatch = normalized.match(/^(.+)-v\d+$/);
    if (versionMatch) {
        variants.push(versionMatch[1]);
    }

    return [...new Set(variants)];
}

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Edit distance
 */
export function levenshteinDistance(a, b) {
    if (!a || !b) return Math.max(a?.length || 0, b?.length || 0);
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    return matrix[b.length][a.length];
}
