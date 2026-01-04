/**
 * FNI Calculation Logic [P, V, C, U]
 */
import { CONFIG } from './fni-config.js';
import { detectAnomalies, getAnomalyMultiplier } from './fni-analysis.js';

/**
 * Calculate P (Popularity) score [0-100]
 */
export function calculateP(model) {
    const { MAX_LIKES, MAX_DOWNLOADS, MAX_GITHUB_STARS } = CONFIG.NORMALIZATION;

    const likes = Math.min((model.likes || 0) / MAX_LIKES, 1) * 100;
    const downloads = Math.min((model.downloads || 0) / MAX_DOWNLOADS, 1) * 100;
    const stars = model.github_stars
        ? Math.min(model.github_stars / MAX_GITHUB_STARS, 1) * 100
        : likes;  // Fallback to likes if no stars

    return Math.round((likes * 0.4 + downloads * 0.3 + stars * 0.3) * 10) / 10;
}

/**
 * Calculate V (Velocity) score [0-100]
 * V14.4 Art 4.3: Cold Start handling for new entities
 */
export function calculateV(model) {
    const { MAX_VELOCITY } = CONFIG.NORMALIZATION;

    // V14.4 Art 4.3: Cold Start for new entities (< 7 days)
    const createdAt = model.created_at || model.createdAt || model.first_seen;
    if (createdAt) {
        const ageMs = Date.now() - new Date(createdAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        if (ageDays < 7) {
            // Incubation mode: use delta approximation
            const likesDelta = model.likes_delta || model.likes_7d || 0;
            const downloadsDelta = model.downloads_delta || model.downloads_7d || 0;
            const coldStartVelocity = (likesDelta + downloadsDelta) * 0.5;
            return Math.round(Math.min(coldStartVelocity, 100) * 10) / 10;
        }
    }

    // Standard mode: use existing velocity field (7-day growth rate)
    const velocity = model.velocity || model.velocity_score || 0;

    return Math.round(Math.min((velocity / MAX_VELOCITY) * 100, 100) * 10) / 10;
}


/**
 * Calculate C (Credibility) score [0-100]
 */
export function calculateC(model) {
    let score = 0;

    // Academic backing (40 points)
    if (model.arxiv_id) score += 20;
    const relations = typeof model.relations === 'string'
        ? JSON.parse(model.relations || '[]')
        : (model.relations || []);
    if (relations.some(r => r.type === 'based_on_paper')) score += 20;

    // Documentation completeness (30 points)
    const readmeLength = model.body_content?.length || 0;
    if (readmeLength > 500) score += 10;
    if (readmeLength > 2000) score += 10;
    if (readmeLength > 10000) score += 10;

    // Author reputation (30 points)
    const author = (model.author || '').toLowerCase();
    if (CONFIG.BIG_CORPS.includes(author)) {
        score += 30;
    } else if (author.includes('ai') || author.includes('lab')) {
        score += 15;  // Partial credit for AI-focused orgs
    }

    return Math.min(100, Math.round(score * 10) / 10);
}

/**
 * Calculate U (Utility) score [0-100]
 * V3.3 Data Expansion: "Runtime First" Strategy
 */
export function calculateU(model) {
    let score = 0;
    const { UTILITY } = CONFIG;

    // 1. Ollama support (30 points) - "Can I run this with one command?"
    if (model.has_ollama || model.ollama_id) {
        score += UTILITY.OLLAMA_BONUS;
    }

    // 2. GGUF quantization (25 points) - "Can I run this on consumer hardware?"
    if (model.has_gguf || (model.gguf_variants && model.gguf_variants.length > 0)) {
        score += UTILITY.GGUF_BONUS;
    }

    // 3. Comprehensive documentation (15 points)
    const readmeLength = model.body_content?.length || 0;
    if (readmeLength > 5000) {
        score += UTILITY.COMPLETE_README;
    } else if (readmeLength > 2000) {
        score += UTILITY.COMPLETE_README * 0.5;
    }

    // 4. Docker support (10 points)
    const tags = Array.isArray(model.tags) ? model.tags : [];
    if (tags.some(t => t.toLowerCase().includes('docker'))) {
        score += UTILITY.DOCKER_BONUS;
    }

    // 5. Has Inference API (10 points)
    const meta = typeof model.meta_json === 'string'
        ? JSON.parse(model.meta_json || '{}')
        : (model.meta_json || {});
    if (meta.has_inference_api || meta.inference) {
        score += UTILITY.API_BONUS;
    }

    return Math.min(100, Math.round(score * 10) / 10);
}

/**
 * Calculate complete FNI for a model
 * V3.3: Added U dimension
 */
export function calculateFNI(model, allModels) {
    const P = calculateP(model);
    const V = calculateV(model);
    const C = calculateC(model);
    const U = calculateU(model);  // V3.3 Data Expansion

    const anomalyFlags = detectAnomalies(model, allModels);
    const anomalyMultiplier = getAnomalyMultiplier(anomalyFlags);

    const rawScore = (P * CONFIG.WEIGHTS.P) + (V * CONFIG.WEIGHTS.V) + (C * CONFIG.WEIGHTS.C) + (U * CONFIG.WEIGHTS.U);
    const finalScore = rawScore * anomalyMultiplier;

    return {
        fni_score: Math.round(finalScore * 10) / 10,
        fni_p: P,
        fni_v: V,
        fni_c: C,
        fni_u: U,  // V3.3 Data Expansion
        fni_anomaly_flags: anomalyFlags,
        fni_raw_score: rawScore  // Before penalty
    };
}
