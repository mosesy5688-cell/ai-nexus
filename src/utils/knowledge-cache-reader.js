// Knowledge Cache Reader (V16.3)
// Standardized: Unified 6-Way Mesh discovery logic

/**
 * Normalizes entity IDs to facilitate flexible matching across platforms.
 */
export function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    return id
        .replace(/^(replicate|github|huggingface|hf|arxiv|kb|concept|report|paper|model|agent|tool|dataset|space|huggingface_deepspec)[:\-]+/, '')
        .replace(/^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|huggingface_deepspec)--/, '')
        .replace(/:/g, '--')
        .replace(/\//g, '--')
        .toLowerCase();
}

/**
 * Fetch Mesh Relations with performance gating for SSR.
 * V16: Improved bidirectional matching.
 */
export async function fetchMeshRelations(locals, entityId = null, options = { ssrOnly: true }) {
    const R2 = locals?.runtime?.env?.R2_ASSETS;
    if (!R2) return [];

    const target = stripPrefix(entityId);
    let allRelations = [];

    const sourcesToFetch = [
        'cache/relations.json',
        'cache/relations/explicit.json',
        'cache/relations/knowledge-links.json',
        'data/relations.json'
    ];

    try {
        for (const key of sourcesToFetch) {
            try {
                const obj = await R2.get(key);
                if (!obj) continue;
                const data = await obj.json();

                // Detection of Root Dictionary (explicit.json)
                if (typeof data === 'object' && !Array.isArray(data) && !data.edges && !data.links && !data.relations) {
                    Object.entries(data).forEach(([srcId, targets]) => {
                        if (srcId.startsWith('_')) return;
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

                // Nested .edges (Legacy/Alt format)
                if (data.edges && typeof data.edges === 'object') {
                    Object.entries(data.edges).forEach(([srcId, targets]) => {
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

                // Standard .relations array or Root Array
                if (Array.isArray(data.relations)) {
                    allRelations = allRelations.concat(data.relations);
                } else if (Array.isArray(data)) {
                    allRelations = allRelations.concat(data);
                }

                // .links array (knowledge-links.json)
                if (Array.isArray(data.links)) {
                    data.links.forEach(link => {
                        if (link.entity_id && Array.isArray(link.knowledge)) {
                            link.knowledge.forEach(k => {
                                allRelations.push({
                                    source_id: link.entity_id,
                                    target_id: typeof k === 'string' ? `concept--${k}` : `concept--${k.slug}`,
                                    relation_type: 'EXPLAIN',
                                    confidence: k?.confidence || 1.0
                                });
                            });
                        }
                    });
                }
            } catch (inner) {
                console.warn(`[KnowledgeReader] Failed ${key}:`, inner.message);
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

            // Bidirectional check: Is the current entity either source or target?
            if (target && normS !== target && normT !== target) continue;

            const dupKey = `${sid}|${tid}|${rel.relation_type}`;
            if (seen.has(dupKey)) continue;
            seen.add(dupKey);

            const getType = (id) => {
                if (!id) return 'model';
                if (id.includes('concept--')) return 'concept';
                if (id.includes('report--')) return 'report';
                if (id.includes('arxiv--') || id.includes('paper--')) return 'paper';
                if (id.includes('dataset--')) return 'dataset';
                if (id.includes('space--')) return 'space';
                if (id.includes('agent--')) return 'agent';
                if (id.includes('tool--')) return 'tool';
                return 'model';
            };

            filtered.push({
                ...rel,
                norm_source: normS,
                norm_target: normT,
                source_type: getType(sid),
                target_type: getType(tid)
            });
        }
        return filtered;
    } catch (e) {
        console.error('[KnowledgeReader] Mesh Error:', e);
        return [];
    }
}

/**
 * Fetch Graph Node Metadata (Icons, Types, Flags) from R2.
 */
export async function fetchGraphMetadata(locals) {
    const R2 = locals?.runtime?.env?.R2_ASSETS;
    if (!R2) return {};
    try {
        const obj = await R2.get('cache/relations/explicit.json');
        if (!obj) return {};
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
