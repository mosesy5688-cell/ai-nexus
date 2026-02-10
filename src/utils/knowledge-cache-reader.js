// Knowledge Cache Reader (V16.4)
export { stripPrefix, getTypeFromId, getRouteFromId, normalizeSlug, isMatch, KNOWLEDGE_ALIAS_MAP } from './mesh-routing-core.js';
import { stripPrefix, getTypeFromId, normalizeSlug, isMatch } from './mesh-routing-core.js';
import { loadCachedJSON } from './loadCachedJSON.js';

// Bidirectional matching and ingestion logic

export async function fetchMeshRelations(locals, entityId = null, options = { ssrOnly: true }) {
    const R2 = locals?.runtime?.env?.R2_ASSETS;

    const target = stripPrefix(entityId);
    let allRelations = [];

    // V16.95: Full 7-Source Aggregation (Perfect SSOT Recovery)
    // V16.96: SSR Memory Protection - Exclude multi-MB files during SSR to prevent 1102 Errors
    // V18.2.5: Emergency - Use ONLY core relations for SSR to bypass CPU/RAM limits
    const sourcesToFetch = options.ssrOnly ? [
        'cache/relations.json'
    ] : [
        'cache/mesh/graph.json',
        'cache/relations.json',
        'cache/relations/explicit.json',
        'cache/relations/knowledge-links.json',
        'cache/knowledge/index.json',
        'cache/reports/index.json',
        'cache/mesh/stats.json'
    ];

    try {
        for (const key of sourcesToFetch) {
            try {
                // V16.10: Use loadCachedJSON for environment-aware fetching
                const { data } = await loadCachedJSON(key, { locals });
                if (!data) continue;

                // 1. Unified Graph Format (edges: { src: [[target, type, weight], ...] })
                if (data.edges) {
                    Object.entries(data.edges).forEach(([srcId, targets]) => {
                        (Array.isArray(targets) ? targets : []).forEach(edge => {
                            const tid = edge.target || (Array.isArray(edge) ? edge[0] : null);
                            if (!tid) return;
                            allRelations.push({
                                source_id: srcId,
                                target_id: tid,
                                relation_type: edge.type || (Array.isArray(edge) ? edge[1] : null) || 'RELATED',
                                confidence: edge.weight || (Array.isArray(edge) ? edge[2] : null) || 0.8
                            });
                        });
                    });
                }

                // 2. Explicit Relations Array
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

                // 3. Knowledge Links (link.knowledge is an array)
                const links = data.links || (Array.isArray(data) ? data : []);
                if (Array.isArray(links)) {
                    links.forEach(link => {
                        const sid = link.entity_id || link.id;
                        if (sid && Array.isArray(link.knowledge)) {
                            link.knowledge.forEach(k => {
                                allRelations.push({
                                    source_id: sid,
                                    target_id: `knowledge--${k.slug || k.id || k}`,
                                    relation_type: 'EXPLAINS',
                                    confidence: k.confidence || 1.0
                                });
                            });
                        }
                    });
                }

                // 4. Reports Integration (FEATURED_IN)
                if (Array.isArray(data.reports)) {
                    data.reports.forEach(report => {
                        const rid = `report--${report.id}`;
                        if (Array.isArray(report.entities)) {
                            report.entities.forEach(eid => {
                                allRelations.push({
                                    source_id: eid,
                                    target_id: rid,
                                    relation_type: 'FEATURED_IN',
                                    confidence: 1.0
                                });
                            });
                        }
                    });
                }
            } catch (inner) {
                console.warn(`[KnowledgeReader] Skip source ${key}:`, inner.message);
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
    try {
        // V16.96: Skip heavy graph metadata during SSR to preserve memory
        // V18.2.7: Allow if NOT in SSR (client-side) or explicit override
        const isSSR = Boolean(locals?.runtime?.env);
        if (isSSR) return {};

        // V16.10: Use loadCachedJSON for environment-aware fetching
        const { data } = await loadCachedJSON('cache/mesh/graph.json', { locals });
        if (data) return data.nodes || {};

        // Fallback to explicit
        const { data: legacy } = await loadCachedJSON('cache/relations/explicit.json', { locals });
        return legacy?.nodes || {};
    } catch (e) {
        console.warn('[KnowledgeReader] Metadata load failed:', e.message);
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
