// Knowledge Cache Reader (V16.4)
// Standardized: Unified 6-Way Mesh discovery logic
export { stripPrefix, getTypeFromId, getRouteFromId, normalizeSlug } from './mesh-routing-core.js';
import { stripPrefix, getTypeFromId, normalizeSlug } from './mesh-routing-core.js';

/**
 * Bidirectional check: Is the current entity either source or target?
 * V16.2: Add fuzzy overlap for organizations (meta vs meta-llama)
 */
export const isMatch = (a, b) => {
    if (!a || !b) return false;
    const aNorm = stripPrefix(a);
    const bNorm = stripPrefix(b);
    if (aNorm === bNorm) return true;

    // V16.2: Fuzzy substring match
    if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return true;

    // V16.60: Deep Semantic Match (handle inconsistent separators and naming)
    const aClean = aNorm.replace(/[^a-z0-9]/g, '');
    const bClean = bNorm.replace(/[^a-z0-9]/g, '');
    if (aClean === bClean) return true;
    if (aClean.includes(bClean) || bClean.includes(aClean)) return true;

    // V16.61: Fragment-Based Strategic Matching (High Entropy Collision)
    // Solves meta--meta-llama vs meta-llama--llama-3-8b
    const aCore = aNorm.split('--').pop();
    const bCore = bNorm.split('--').pop();
    if (aCore && bCore && aCore.length > 5) {
        if (aCore.includes(bCore) || bCore.includes(aCore)) return true;
    }

    return false;
};

/**
 * Fetch Mesh Relations with performance gating for SSR.
 * V16: Improved bidirectional matching.
 */
export async function fetchMeshRelations(locals, entityId = null, options = { ssrOnly: true }) {
    const R2 = locals?.runtime?.env?.R2_ASSETS;
    if (!R2) return [];

    const target = stripPrefix(entityId);
    let allRelations = [];

    // Prioritize V16.2 Unified Graph
    const sourcesToFetch = [
        'cache/mesh/graph.json',
        'cache/relations.json',
        'cache/relations/explicit.json',
        'cache/relations/knowledge-links.json'
    ];

    try {
        for (const key of sourcesToFetch) {
            try {
                const obj = await R2.get(key);
                if (!obj) continue;
                const data = await obj.json();

                // 1. Unified Graph Format (V16.x / V15.x / V14.x)
                // Checks for 'edges' property regardless of version gating
                if (data.edges && typeof data.edges === 'object') {
                    Object.entries(data.edges).forEach(([srcId, targets]) => {
                        if (Array.isArray(targets)) {
                            targets.forEach(edge => {
                                // Handle both [target, type, weight] and {target, type, weight}
                                const targetId = edge.target || (Array.isArray(edge) ? edge[0] : null);
                                if (!targetId) return;
                                allRelations.push({
                                    source_id: srcId,
                                    target_id: targetId,
                                    relation_type: edge.type || (Array.isArray(edge) ? edge[1] : null) || 'RELATED',
                                    confidence: edge.weight || (Array.isArray(edge) ? edge[2] : null) || 0.8
                                });
                            });
                        }
                    });
                }

                // 2. Explicit Relations Array (.relations) - Common in V14.5 / V15.x
                if (Array.isArray(data.relations)) {
                    data.relations.forEach(rel => {
                        if (rel.source_id && rel.target_id) {
                            allRelations.push({
                                source_id: rel.source_id,
                                target_id: rel.target_id,
                                relation_type: rel.relation_type || 'RELATED',
                                confidence: rel.confidence || 0.8
                            });
                        }
                    });
                }

                // 3. Knowledge Links (Array or .links object)
                // R2 knowledge-links.json is often a direct array
                const linksArray = Array.isArray(data) ? data : (data.links || []);
                if (Array.isArray(linksArray)) {
                    linksArray.forEach(link => {
                        const sid = link.entity_id || link.id;
                        if (sid && Array.isArray(link.knowledge)) {
                            link.knowledge.forEach(k => {
                                allRelations.push({
                                    source_id: sid,
                                    target_id: typeof k === 'string' ? `knowledge--${k}` : `knowledge--${k.slug || k.id}`,
                                    relation_type: 'EXPLAINS',
                                    confidence: k?.confidence || 1.0
                                });
                            });
                        }
                    });
                }

                // 4. Fallback for Key-Value Dictionary formats
                if (typeof data === 'object' && !Array.isArray(data) && !data.edges && !data.relations && !data.links) {
                    Object.entries(data).forEach(([srcId, targets]) => {
                        if (srcId.startsWith('_')) return; // Metadata ignore
                        if (Array.isArray(targets)) {
                            targets.forEach(edge => {
                                if (Array.isArray(edge) && edge.length >= 1) {
                                    allRelations.push({
                                        source_id: srcId,
                                        target_id: edge[0],
                                        relation_type: edge[1] || 'RELATED',
                                        confidence: edge[2] || 0.8
                                    });
                                }
                            });
                        }
                    });
                }
            } catch (inner) {
                console.warn(`[KnowledgeReader] Failed to ingest ${key}:`, inner.message);
            }
        }

        const filtered = [];
        const seen = new Set();

        for (const rel of allRelations) {
            const sid = rel.source_id;
            const tid = rel.target_id;
            if (!sid || !tid) continue;

            const normS = stripPrefix(sid);
            const normT = stripPrefix(tid);
            const normTarget = target ? stripPrefix(target) : null;

            // V16.4 Directional Alignment: Identify 'Other' ID relative to the current landing page
            let otherId = null;
            let otherNorm = null;

            if (normTarget) {
                if (isMatch(normS, normTarget)) {
                    otherId = tid;
                    otherNorm = normT;
                } else if (isMatch(normT, normTarget)) {
                    otherId = sid;
                    otherNorm = normS;
                }
            } else {
                // If no specific target requested (e.g. global graph view), keep original
                otherId = tid;
                otherNorm = normT;
            }

            if (!otherId || (normTarget && isMatch(otherNorm, normTarget))) continue;

            // V16.4 Triple-Source De-duplication: One node per type per context
            const relType = rel.relation_type || 'RELATED';
            const dupKey = `${otherNorm}|${relType}`;

            if (seen.has(dupKey)) continue;
            seen.add(dupKey);

            filtered.push({
                ...rel,
                target_id: otherId, // Override to always be the 'Other' node
                norm_source: normS,
                norm_target: normT,
                source_type: getTypeFromId(sid),
                target_type: getTypeFromId(otherId)
            });
        }
        return filtered;
    } catch (e) {
        console.error('[KnowledgeReader] Mesh Error:', e);
        return [];
    }
}


/**
 * Fetch Graph Node Metadata (Icons, Types, Flags) from V16.2 Graph.
 */
export async function fetchGraphMetadata(locals) {
    const R2 = locals?.runtime?.env?.R2_ASSETS;
    if (!R2) return {};
    try {
        const obj = await R2.get('cache/mesh/graph.json');
        if (!obj) {
            // Fallback to explicit
            const legacy = await R2.get('cache/relations/explicit.json');
            if (!legacy) return {};
            const data = await legacy.json();
            return data.nodes || {};
        }
        const data = await obj.json();
        return data.nodes || {};
    } catch (e) {
        return {};
    }
}

/**
 * Concept metadata fetcher (Legacy/Refined)
 */
export async function fetchConceptMetadata(locals) {
    const R2 = locals?.runtime?.env?.R2_ASSETS;
    if (!R2) return [];
    try {
        const file = await R2.get('cache/knowledge/index.json');
        if (file) {
            const data = await file.json();
            const list = data?.articles || (Array.isArray(data) ? data : []);
            if (Array.isArray(list) && list.length > 0) return list;
        }
    } catch (e) { }
    // Minimum Fallback
    return [{ id: 'concept--mmlu', title: 'MMLU Benchmark', slug: 'mmlu', icon: '🧪' }];
}
