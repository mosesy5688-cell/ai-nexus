/**
 * FNI V2.0: Universal Scoring Algorithm
 * Unified Source-Based Scoring for HuggingFace, GitHub, and ArXiv.
 */
export function calculateFNI(entity, options = {}) {
    let score = 0;
    const id = entity.id || entity.slug || '';
    const stats = entity.stats || entity;
    const type = entity.type || entity.entity_type || 'model';

    // --- 1. Source Routing ---
    let baseScore = 0;
    if (id.startsWith('hf-')) {
        baseScore = calcHuggingFace(type, stats);
    }
    else if (id.startsWith('gh-')) {
        baseScore = calcGitHub(stats);
    }
    else if (id.startsWith('arxiv-')) {
        baseScore = calcArXiv(stats, entity.published_at || entity.publishedAt);
    }
    else {
        // Universal Fallback for Ecosystems (CivitAI, MCP, Replicate, Ollama, Kaggle)
        const d = parseInt(stats.downloads || stats.downloadCount || stats.pulls || stats.run_count) || 0;
        const l = parseInt(stats.likes || stats.favoriteCount || stats.upVotes || stats.stars || stats.stargazers_count) || 0;
        const weightedSum = (d * 1) + (l * 20);
        baseScore = weightedSum > 0 ? (Math.log10(weightedSum + 1) / 7.5) * 100 : 25; // Base 25 for ecosystem viability
    }

    score = baseScore;

    // --- 2. Heavy Weighting (V16.6 UPGRADE) ---
    const c = (type === 'model' || type === 'agent' || type === 'tool' || type === 'prompt') ? calcCompleteness(entity) : 0;
    const u = (type === 'model' || type === 'agent') ? calcUtility(entity) : 0;

    if (type === 'model' || type === 'agent') {
        // Blend: 70% Popularity/Velocity + 15% Completeness + 15% Utility
        score = (baseScore * 0.7) + (c * 0.15) + (u * 0.15);
    } else if (type === 'tool' || type === 'prompt') {
        // Blend: 85% Popularity + 15% Completeness
        score = (baseScore * 0.85) + (c * 0.15);
    }

    // --- 3. Time Decay ---
    const date = entity.last_modified || entity.pushed_at || entity.published_at || entity.updated_at || entity.updatedAt;
    const finalScore = applyTimeDecay(score, date);
    const roundedScore = Math.min(100, Math.max(0, Math.round(finalScore)));

    if (options.includeMetrics) {
        // V16.5 Spec Alignment
        const decayAmount = score > 0 ? (finalScore / score) * 100 : 0; // Freshness proxy
        return {
            score: roundedScore,
            metrics: {
                p: Math.round(Math.min(100, baseScore)), // Popularity
                v: Math.round(Math.min(100, decayAmount)), // Velocity/Freshness
                c: Math.round(c), // Credibility/Completeness
                u: Math.round(u)  // Utility
            }
        };
    }

    return roundedScore;
}

function calcCompleteness(entity) {
    let s = 0;
    if ((entity.body_content || '').length > 500) s += 40;
    if (entity.params_billions || entity.params) s += 30;
    if (entity.tags?.length > 0) s += 15;
    if (entity.author && entity.author !== 'Community') s += 15;
    return s;
}

function calcUtility(entity) {
    let s = 30; // Base
    if (entity.has_ollama || entity.has_gguf) s += 40;
    if (entity.spaces_count > 0 || entity.has_demo) s += 30;
    return Math.min(100, s);
}

// --- Internal Strategies ---

/**
 * Strategy A: The HuggingFace Economy
 */
function calcHuggingFace(type, stats) {
    const d = parseInt(stats.downloads || stats.download_count) || 0;
    const l = parseInt(stats.likes || stats.like_count) || 0;

    let wD = 1, wL = 20;

    // Type-specific weights per SPEC-FNI-V2.0
    if (type === 'space') {
        wD = 0;
        wL = 100; // Likes are the only currency for Spaces
    } else if (type === 'dataset') {
        wD = 0.5; // Datasets have high bulk downloads, need de-weighting
    } else if (type === 'model' || type === 'agent') {
        wD = 1.0;
        wL = 20.0; // 1 Like ≈ 20 Downloads
    }

    // Logic: Log10(WeightedSum) mapped to 0-100
    // Anchor: 1M downloads -> log10(1,000,001) ≈ 6. (6 / 7) * 100 ≈ 85.7
    const weightedSum = (d * wD) + (l * wL);
    return (Math.log10(weightedSum + 1) / 7.0) * 100;
}

/**
 * Strategy B: The GitHub Economy
 */
function calcGitHub(stats) {
    const s = parseInt(stats.stars || stats.stargazers_count) || 0;
    const f = parseInt(stats.forks || stats.forks_count) || 0;

    // Fork represents deeper engagement and weighs 2x
    // Anchor: 30k stars -> log10(30,001) ≈ 4.47. (4.47 / 5) * 100 ≈ 89.4 (AutoGPT Peak)
    const weightedSum = (s * 1) + (f * 2);
    return (Math.log10(weightedSum + 1) / 5.0) * 100;
}

/**
 * Strategy C: The ArXiv Economy
 */
function calcArXiv(stats, pubDate) {
    const c = parseInt(stats.citations || stats.citation_count) || 0;

    // Core Cite Score
    // Anchor: 1000 citations -> log10(10,001) = 4. (4 / 4) * 100 = 100.
    let score = (Math.log10(c * 10 + 1) / 4.0) * 100;

    // New Paper Bonus (Newer than 60 days)
    if (pubDate) {
        const days = (new Date() - new Date(pubDate)) / 86400000;
        if (days < 60 && days >= 0) {
            score *= 1.5; // "Star Booster" for new research
        }
    }

    return score;
}

/**
 * Time Decay Logic
 * Reduces score for inactive projects to ensure trending accuracy.
 */
function applyTimeDecay(score, dateStr) {
    if (!dateStr) return score * 0.5; // Zombie Penalty: High penalty if we don't know it's alive

    const daysSince = (new Date() - new Date(dateStr)) / 86400000;

    // Grace Period: No decay for 30 days
    if (daysSince <= 30) return score;

    // Linear decay: 0.1% per day after 30 days, floor at 60%
    const decayFactor = Math.max(0.6, 1 - ((daysSince - 30) * 0.001));

    return score * decayFactor;
}
