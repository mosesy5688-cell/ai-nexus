/**
 * V25.8 Hub Scorer - Unified Mesh Centrality Engine
 *
 * Implements the V25.8 scoring formula:
 *   Score = 0.35 * FNI + 0.25 * Citations + 0.25 * Mesh_Degree + 0.15 * Recency
 *
 * Spec §3.2: MAX_RELATIONS = 20, HUB_DEGREE_LIMIT = 200
 * Phase 3 JS implementation. Will be replaced by hub-scorer-rust in Phase 3+.
 */

// V25.8 §3.2: Graph Hub Pruning Limits
const MAX_RELATIONS = 20;       // Hard cap: max relations per entity
const HUB_DEGREE_LIMIT = 200;   // Hub degree limit: top weight only

/**
 * Calculate hub score for a single entity.
 * @param {object} entity - Entity with metrics
 * @param {object} meshStats - Graph degree stats { inDegree, outDegree }
 * @returns {number} Hub score 0-100
 */
export function calculateHubScore(entity, meshStats = {}) {
    const fni = Math.min(100, Math.max(0, entity.fni_score || 0));

    // Citation normalization (log scale, anchor at 1000 citations = 100)
    const rawCitations = entity.citation_count || entity.citations || 0;
    const citations = Math.min(100, (Math.log10(rawCitations + 1) / 3) * 100);

    // Mesh degree normalization (anchor at 20 connections = 100)
    // V25.8 §3.2: Cap degree at HUB_DEGREE_LIMIT to prevent hub domination
    const rawDegree = (meshStats.inDegree || 0) + (meshStats.outDegree || 0);
    const degree = Math.min(rawDegree, HUB_DEGREE_LIMIT);
    const meshDegree = Math.min(100, (degree / MAX_RELATIONS) * 100);

    // Recency (exponential decay, 7 days = 100, 90 days = ~40)
    const dateStr = entity.last_modified || entity.updated_at || entity.published_at;
    let recency = 50; // default if no date
    if (dateStr) {
        const daysSince = (Date.now() - new Date(dateStr).getTime()) / 86400000;
        recency = Math.min(100, 100 * Math.exp(-0.015 * Math.max(0, daysSince)));
    }

    const score = (0.35 * fni) + (0.25 * citations) + (0.25 * meshDegree) + (0.15 * recency);
    return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Batch-compute hub scores for all entities.
 * @param {Array} entities - Entity array
 * @param {Map} meshGraph - Map of id -> { inDegree, outDegree }
 * @returns {Map} id -> hubScore
 */
export function batchComputeHubScores(entities, meshGraph = new Map()) {
    console.log(`[HUB-SCORER] Computing hub scores for ${entities.length} entities...`);

    const scores = new Map();
    let scored = 0;

    let pruned = 0;
    for (const entity of entities) {
        const id = entity.id || entity.slug;
        if (!id) continue;

        const meshStats = meshGraph.get(id) || { inDegree: 0, outDegree: 0 };
        // V25.8 §3.2: Prune hub nodes exceeding degree limit
        if ((meshStats.inDegree + meshStats.outDegree) > HUB_DEGREE_LIMIT) {
            meshStats.inDegree = Math.min(meshStats.inDegree, HUB_DEGREE_LIMIT);
            meshStats.outDegree = Math.min(meshStats.outDegree, HUB_DEGREE_LIMIT - meshStats.inDegree);
            pruned++;
        }
        const hubScore = calculateHubScore(entity, meshStats);

        entity.hub_score = hubScore;
        scores.set(id, hubScore);
        scored++;
    }

    // Distribution stats
    const allScores = [...scores.values()].sort((a, b) => a - b);
    const median = allScores[Math.floor(allScores.length / 2)] || 0;
    const p95 = allScores[Math.floor(allScores.length * 0.95)] || 0;

    console.log(`[HUB-SCORER] Scored ${scored} entities (median: ${median}, p95: ${p95}, pruned: ${pruned})`);
    return scores;
}
