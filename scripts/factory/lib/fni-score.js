/**
 * FNI V18.9: Ultimate Singularity Ranking Algorithm
 * Spec: FNI_ALGO_V18.1_ULTIMATE_SINGULARITY (V18.9 Hardened)
 * Formula: FNI = min(99.9, (Sp * 0.45) + (Sf * 0.30) + (Sm * 0.25))
 */

// Section 2: Source Parity Coefficients (Ks)
const SOURCE_COEFFICIENTS = {
    hf: 1.0,       // Model Forge (HuggingFace) - Baseline
    gh: 5.0,       // Tool Source (GitHub)
    arxiv: 30.0,   // Knowledge Roots (ArXiv)
    s2: 30.0,      // Knowledge Roots (Semantic Scholar)
    default: 0.2   // Community Market (CivitAI/Others)
};

// Section 3: Dynamic Exponential Decay Tiers
const DECAY_TIERS = [
    { lambda: 0.002, types: ['model', 'tool', 'agent'] },       // Foundational ~346d half-life
    { lambda: 0.005, types: ['dataset', 'collection', 'paper'] }, // Structural ~138d
    { lambda: 0.025, types: ['prompt', 'space'] }                 // Temporal ~28d
];

/**
 * Main FNI V18.9 Entry Point
 * @param {Object} entity
 * @param {Object} options - { includeMetrics, meshPoints }
 */
export function calculateFNI(entity, options = {}) {
    const id = entity.id || entity.slug || '';
    const stats = entity.stats || entity;
    const type = entity.type || entity.entity_type || 'model';

    // --- Section 2: rawPop = Metrics * Ks ---
    const sourcePrefix = getSourcePrefix(id);
    const Ks = SOURCE_COEFFICIENTS[sourcePrefix] || SOURCE_COEFFICIENTS.default;
    const rawMetrics = extractRawMetrics(stats, sourcePrefix);
    const rawPop = rawMetrics * Ks;

    // --- Quality Correction Factor (Q): Sc + Su folded into Sp ---
    const Sc = calcCompleteness(entity);
    const Su = calcUtility(entity);

    // --- Sp: Asymptotic Log Compressor (base 8) with Quality Correction ---
    const logCompressed = 99.9 * (1 - Math.pow(10, -(Math.log10(rawPop + 1) / 8)));
    const qualityFactor = 1 + (Sc + Su) / 500;
    const Sp_base = Math.min(99.9, logCompressed * qualityFactor);

    // --- Section 3: Sf - Dynamic Exponential Decay ---
    const lambda = getDecayLambda(type);
    const dateStr = entity.last_modified || entity.pushed_at || entity.published_at || entity.updated_at || entity._updated;
    // Null-Time Trap: Force 365-day penalty if missing/invalid (never 0)
    let days = 365;
    if (dateStr) {
        const parsed = new Date(dateStr).getTime();
        if (!isNaN(parsed)) days = Math.max(0, (Date.now() - parsed) / 86400000);
    }
    const Sf = 100 * Math.exp(-lambda * days);

    // Sp with lightweight freshness boost
    const Sp = Math.min(99.9, Sp_base * (1 + Sf / 500));

    // --- Section 4: Sm - Asymptotic Gravity Field ---
    const meshPoints = options.meshPoints ?? entity._mesh_points ?? estimateMeshPoints(entity, sourcePrefix);
    const Sm = 99.9 * (1 - Math.pow(10, -(Math.log10(meshPoints + 1) / 4)));

    // --- Master Formula: FNI = min(99.9, Sp*0.45 + Sf*0.30 + Sm*0.25) ---
    const fni = Math.min(99.9, (Sp * 0.45) + (Sf * 0.30) + (Sm * 0.25));
    const roundedScore = Math.round(fni * 10) / 10;

    if (options.includeMetrics) {
        return {
            score: roundedScore,
            rawPop: Math.round(rawPop),
            metrics: {
                p: Math.round(Math.min(99.9, Sp) * 10) / 10,
                f: Math.round(Sf * 10) / 10,
                v: Math.round(Sm * 10) / 10, // v slot stores Mesh (Sm) in V18.9
                c: Math.round(Sc),
                u: Math.round(Su)
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
