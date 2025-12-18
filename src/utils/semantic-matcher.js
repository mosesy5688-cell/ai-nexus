// src/utils/semantic-matcher.js
/**
 * Semantic UMID Matcher V4.3.2
 * Constitution V4.3.2 Compliant - Embedding-based model matching
 * 
 * Uses Cloudflare Workers AI @cf/baai/bge-base-en-v1.5 for embeddings
 * Implements circuit breaker pattern for resilience
 * 
 * Thresholds (Constitution V4.3.2):
 * - ≥ 0.88: ACCEPT (high confidence match)
 * - 0.65-0.88: REVIEW (needs manual verification)
 * - < 0.65: REJECT (no match)
 */

// Circuit Breaker Configuration
import { CircuitBreaker } from './circuit-breaker.js';
const breaker = new CircuitBreaker();

/**
 * Generate embedding using Cloudflare Workers AI
 * @param {Object} AI - Cloudflare AI binding
 * @param {string} text - Text to embed
 * @returns {Promise<number[]|null>} - Embedding vector or null
 */
async function generateEmbedding(AI, text) {
    if (!AI) {
        console.warn('[SemanticMatcher] AI binding not available');
        return null;
    }

    if (breaker.isOpen()) {
        console.warn('[SemanticMatcher] Circuit breaker OPEN, skipping AI call');
        return null;
    }

    try {
        const result = await AI.run('@cf/baai/bge-base-en-v1.5', {
            text: [text]
        });

        breaker.recordSuccess();
        return result?.data?.[0] || null;
    } catch (error) {
        console.error('[SemanticMatcher] Embedding error:', error.message);
        breaker.recordFailure();
        return null;
    }
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} - Similarity score 0-1
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Classify match based on similarity score
 * @param {number} similarity - Similarity score 0-1
 * @returns {{action: string, confidence: number}}
 */
function classifyMatch(similarity) {
    if (similarity >= THRESHOLDS.ACCEPT) {
        return { action: 'ACCEPT', confidence: similarity };
    } else if (similarity >= THRESHOLDS.REVIEW) {
        return { action: 'REVIEW', confidence: similarity };
    } else if (similarity >= THRESHOLDS.REJECT) {
        return { action: 'LOW_CONFIDENCE', confidence: similarity };
    } else {
        return { action: 'REJECT', confidence: similarity };
    }
}

/**
 * Find best semantic match for a query in a list of candidates
 * @param {Object} AI - Cloudflare AI binding
 * @param {string} query - Query text (model name/description)
 * @param {Array<{text: string, id: string}>} candidates - Candidate matches
 * @returns {Promise<{match: Object|null, similarity: number, action: string}>}
 */
export async function findBestMatch(AI, query, candidates) {
    if (!candidates || candidates.length === 0) {
        return { match: null, similarity: 0, action: 'NO_CANDIDATES' };
    }

    const queryEmbedding = await generateEmbedding(AI, query);
    if (!queryEmbedding) {
        return { match: null, similarity: 0, action: 'EMBEDDING_FAILED' };
    }

    let bestMatch = null;
    let bestSimilarity = 0;

    for (const candidate of candidates) {
        const candidateEmbedding = await generateEmbedding(AI, candidate.text);
        if (!candidateEmbedding) continue;

        const similarity = cosineSimilarity(queryEmbedding, candidateEmbedding);
        if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestMatch = candidate;
        }
    }

    const classification = classifyMatch(bestSimilarity);

    return {
        match: bestMatch,
        similarity: bestSimilarity,
        ...classification
    };
}

/**
 * Calculate multi-channel UMID match score (Constitution V4.3.2)
 * @param {Object} model1 - First model
 * @param {Object} model2 - Second model
 * @param {number} nameSimilarity - Name similarity from embedding (0-1)
 * @returns {number} - Match score 0-1
 */
export function calculateUMIDMatchScore(model1, model2, nameSimilarity) {
    let score = 0;

    // Name similarity (50% weight)
    score += 0.50 * nameSimilarity;

    // Author fingerprint (20% weight)
    const author1 = (model1.author || '').toLowerCase().trim();
    const author2 = (model2.author || '').toLowerCase().trim();
    const authorMatch = author1 === author2 ? 1 :
        author1.includes(author2) || author2.includes(author1) ? 0.5 : 0;
    score += 0.20 * authorMatch;

    // Parameters similarity (15% weight) - within ±20%
    const params1 = parseFloat(model1.params_b) || 0;
    const params2 = parseFloat(model2.params_b) || 0;
    if (params1 > 0 && params2 > 0) {
        const ratio = Math.min(params1, params2) / Math.max(params1, params2);
        const paramsMatch = ratio >= 0.8 ? 1 : ratio >= 0.5 ? 0.5 : 0;
        score += 0.15 * paramsMatch;
    }

    // Architecture family (10% weight)
    const arch1 = (model1.architecture || model1.pipeline_tag || '').toLowerCase();
    const arch2 = (model2.architecture || model2.pipeline_tag || '').toLowerCase();
    const archMatch = arch1 === arch2 ? 1 :
        arch1.includes(arch2) || arch2.includes(arch1) ? 0.5 : 0;
    score += 0.10 * archMatch;

    // License match (5% weight)
    const license1 = (model1.license || '').toLowerCase();
    const license2 = (model2.license || '').toLowerCase();
    const licenseMatch = license1 === license2 ? 1 : 0;
    score += 0.05 * licenseMatch;

    return Math.min(score, 1.0);
}

/**
 * Get circuit breaker status
 * @returns {Object}
 */
export function getCircuitBreakerStatus() {
    return breaker.getStatus();
}

/**
 * Reset circuit breaker (for testing/manual recovery)
 */
export function resetCircuitBreaker() {
    breaker.reset();
}

// Export thresholds for external use
export { THRESHOLDS, cosineSimilarity, classifyMatch };
