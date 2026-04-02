// ═══════════════════════════════════════════
// FNI V2.0 — Canonical (2026-04-02)
// Formula: FNI = min(99.9, 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q)
// Upgraded from V18.9 (Phase 6, 768-dim bge-base-en-v1.5)
// S = Semantic (query-time ANN, factory default 50.0)
// A = Authority (mesh gravity), P = Popularity (log metrics)
// R = Recency (exp decay), Q = Quality (completeness + utility)
// ═══════════════════════════════════════════

/**
 * FNI V2.0: Canonical Ranking Algorithm
 * Spec: V∞ §3.1
 * Formula: FNI = min(99.9, 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q)
 */

// Section 2: Source Parity Coefficients (Ks)
const SOURCE_COEFFICIENTS = {
    hf: 1.0,       // Model Forge (HuggingFace) - Baseline
    gh: 5.0,       // Tool Source (GitHub)
    arxiv: 30.0,   // Knowledge Roots (ArXiv)
    s2: 30.0,      // Knowledge Roots (Semantic Scholar)
    default: 0.2   // Community Market (CivitAI/Others)
};

// Section 3: Dynamic Exponential Decay Tiers (content freshness)
const DECAY_TIERS = [
    { lambda: 0.002, types: ['model', 'tool', 'agent'] },       // Foundational ~346d half-life
    { lambda: 0.005, types: ['dataset', 'collection', 'paper'] }, // Structural ~138d
    { lambda: 0.025, types: ['prompt', 'space'] }                 // Temporal ~28d
];

// V25.8 Art 8.2: Staleness decay lambdas (harvest freshness, NOT content age)
// Applied at read-time based on _last_seen — zero write pressure at 10M scale
const STALENESS_LAMBDAS = {
    model: 0.005,   // 30d → 86% retained, 90d → 64%
    tool: 0.005,
    agent: 0.005,
    dataset: 0.003, // 30d → 91%, 90d → 76%
    collection: 0.003,
    paper: 0.001,   // 30d → 97%, 90d → 91% (papers rarely change)
    prompt: 0.008,  // 30d → 79% (volatile, decay faster)
    space: 0.008,
    default: 0.005
};

/**
 * Main FNI V2.0 Entry Point
 * @param {Object} entity
 * @param {Object} options - { includeMetrics, meshPoints, semanticScore }
 */
export function calculateFNI(entity, options = {}) {
    const id = entity.id || entity.slug || '';
    const stats = entity.stats || entity;
    const type = entity.type || entity.entity_type || 'model';

    // --- S: Semantic Factor (query-time ANN cosine similarity) ---
    // At factory time, S defaults to 50.0 (neutral). At query time, SSR
    // replaces this with real cosine similarity × 100 from cluster ANN.
    const S = Math.min(99.9, options.semanticScore ?? 50.0);

    // --- P: Popularity (Asymptotic Log Compressor, base 8) ---
    const sourcePrefix = getSourcePrefix(id);
    const Ks = SOURCE_COEFFICIENTS[sourcePrefix] || SOURCE_COEFFICIENTS.default;
    const rawMetrics = extractRawMetrics(stats, sourcePrefix);
    const rawPop = rawMetrics * Ks;
    const P = Math.min(99.9, 99.9 * (1 - Math.pow(10, -(Math.log10(rawPop + 1) / 8))));

    // --- R: Recency (Dynamic Exponential Decay) ---
    const lambda = getDecayLambda(type);
    const dateStr = entity.last_modified || entity.pushed_at || entity.published_at || entity.updated_at || entity._updated;
    let days = 365; // Null-Time Trap: 365-day penalty if missing
    if (dateStr) {
        const parsed = new Date(dateStr).getTime();
        if (!isNaN(parsed)) days = Math.max(0, (Date.now() - parsed) / 86400000);
    }
    const R = Math.min(99.9, 100 * Math.exp(-lambda * days));

    // --- A: Authority (Asymptotic Gravity Field from mesh/citations) ---
    const meshPoints = options.meshPoints ?? entity._mesh_points ?? estimateMeshPoints(entity, sourcePrefix);
    const A = Math.min(99.9, 99.9 * (1 - Math.pow(10, -(Math.log10(meshPoints + 1) / 4))));

    // --- Q: Quality (Completeness + Utility, normalized to 0-99.9) ---
    const Sc = calcCompleteness(entity);
    const Su = calcUtility(entity);
    const Q = Math.min(99.9, (Sc + Su) / 2);

    // --- Master Formula: FNI = min(99.9, 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q) ---
    const baseFni = Math.min(99.9, (0.35 * S) + (0.25 * A) + (0.15 * P) + (0.15 * R) + (0.10 * Q));

    // Staleness decay — penalize entities not recently harvested
    const stalenessFactor = computeStalenessFactor(type, options.lastSeen);
    const fni = baseFni * stalenessFactor;
    const roundedScore = Math.round(fni * 10) / 10;

    if (options.includeMetrics) {
        return {
            score: roundedScore,
            rawPop: Math.round(rawPop),
            metrics: {
                s: Math.round(S * 10) / 10,
                a: Math.round(A * 10) / 10,
                p: Math.round(P * 10) / 10,
                r: Math.round(R * 10) / 10,
                q: Math.round(Q * 10) / 10
            }
        };
    }
    return roundedScore;
}

function getSourcePrefix(id) {
    if (id.startsWith('hf-')) return 'hf';
    if (id.startsWith('gh-')) return 'gh';
    if (id.startsWith('arxiv-')) return 'arxiv';
    if (id.startsWith('s2-')) return 's2';
    return 'default';
}

function extractRawMetrics(stats, sourcePrefix) {
    if (sourcePrefix === 'hf') {
        return (parseInt(stats.likes || stats.like_count) || 0)
             + ((parseInt(stats.downloads || stats.download_count) || 0) * 0.01);
    }
    if (sourcePrefix === 'gh') {
        return (parseInt(stats.stars || stats.stargazers_count) || 0)
             + ((parseInt(stats.forks || stats.forks_count) || 0) * 2);
    }
    if (sourcePrefix === 'arxiv' || sourcePrefix === 's2') {
        return parseInt(stats.citations || stats.citation_count || stats.upvotes || stats.popularity || stats.likes) || 0;
    }
    const d = parseInt(stats.downloads || stats.downloadCount || stats.pulls || stats.run_count || 0) || 0;
    const l = parseInt(stats.likes || stats.stars || stats.favoriteCount || stats.upVotes || stats.stargazers_count || stats.popularity || 0) || 0;
    return (l * 20) + d;
}

function getDecayLambda(type) {
    for (const tier of DECAY_TIERS) {
        if (tier.types.includes(type)) return tier.lambda;
    }
    return 0.005; // Default: structural
}

/**
 * V25.8 Art 8.2: Compute staleness factor based on _last_seen.
 * Returns 1.0 if recently harvested, decays toward 0 for stale entities.
 * Read-time computation — zero writes, scales to 10M+ entities.
 */
function computeStalenessFactor(type, lastSeen) {
    if (!lastSeen) return 1.0; // No _last_seen = first run, no penalty
    const parsed = new Date(lastSeen).getTime();
    if (isNaN(parsed)) return 1.0;
    const daysSinceHarvest = Math.max(0, (Date.now() - parsed) / 86400000);
    if (daysSinceHarvest < 1) return 1.0; // Harvested today
    const lambda = STALENESS_LAMBDAS[type] || STALENESS_LAMBDAS.default;
    return Math.exp(-lambda * daysSinceHarvest);
}

/** Section 4: Estimate mesh gravity points from entity data */
function estimateMeshPoints(entity, sourcePrefix) {
    let points = 0;
    const citations = parseInt(entity.citations || entity.citation_count) || 0;
    const meshDegree = entity.mesh_links?.length || 0;
    // Relation weights synced with Ks (Section 4)
    if (sourcePrefix === 'arxiv' || sourcePrefix === 's2') points += citations * 30;
    else if (sourcePrefix === 'gh') points += citations * 5;
    else points += citations;
    points += meshDegree;
    return points;
}

function calcCompleteness(entity) {
    let s = 0;
    const type = entity.type || entity.entity_type || 'model';
    if ((entity.body_content || entity.readme_content || '').length > 500) s += 40;
    if (type === 'paper') {
        if (entity.arxiv_id || entity.pdf_url || entity.source_url) s += 20;
        if (parseInt(entity.citations || entity.citation_count || entity.upvotes || entity.popularity) > 0) s += 10;
    } else {
        if (entity.params_billions || entity.params || entity.size) s += 30;
    }
    if (entity.tags?.length > 0) s += 15;
    if (entity.author && entity.author !== 'Community') s += 15;
    return s;
}

function calcUtility(entity) {
    let s = 30;
    if (entity.has_ollama || entity.has_gguf || entity.pipeline_tag) s += 40;
    if (entity.spaces_count > 0 || entity.has_demo || entity.mesh_links?.length > 0) s += 30;
    return Math.min(100, s);
}
