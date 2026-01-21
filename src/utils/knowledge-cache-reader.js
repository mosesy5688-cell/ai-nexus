// Knowledge Cache Reader (V16.3)
// Standardized: Unified 6-Way Mesh discovery logic

/**
 * Normalizes entity IDs to facilitate flexible matching across platforms.
 */
export function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    // V16.2 Article 2.2: Dual-dash separator, prefix stripping
    return id
        .replace(/^(replicate|github|huggingface|hf|arxiv|kb|concept|knowledge|report|paper|model|agent|tool|dataset|space|huggingface_deepspec)[:\-]+/, '')
        .replace(/^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|huggingface_deepspec|knowledge|kb|report|arxiv|dataset|tool)--/, '')
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

                // V16.2 Unified Graph format
                if (data.edges && typeof data.edges === 'object' && data._v === '16.2') {
                    Object.entries(data.edges).forEach(([srcId, targets]) => {
                        if (Array.isArray(targets)) {
                            targets.forEach(edge => {
                                allRelations.push({
                                    source_id: srcId,
                                    target_id: edge.target || edge[0],
                                    relation_type: edge.type || edge[1] || 'RELATED',
                                    confidence: edge.weight || edge[2] || 0.8
                                });
                            });
                        }
                    });
                }

                // Explicit Relations (.relations array)
                else if (Array.isArray(data.relations)) {
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

                // Legacy detection of Root Dictionary
                else if (typeof data === 'object' && !Array.isArray(data) && !data.edges && !data.links && !data.relations) {
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

                // .links array (knowledge-links.json)
                else if (Array.isArray(data.links)) {
                    data.links.forEach(link => {
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

                // Standard Root Array
                else if (Array.isArray(data)) {
                    allRelations = allRelations.concat(data);
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
            // V16.2: Add fuzzy overlap for organizations (meta vs meta-llama)
            const isMatch = (a, b) => {
                if (a === b) return true;
                const clean = (s) => s.replace(/^(meta-llama|meta|nvidia|google|openai|anthropic|microsoft)--/, '');
                return clean(a) === clean(b) && (a.includes(clean(a)) || b.includes(clean(b)));
            };

            if (target && !isMatch(normS, target) && !isMatch(normT, target)) continue;

            const dupKey = `${sid}|${tid}|${rel.relation_type}`;
            if (seen.has(dupKey)) continue;
            seen.add(dupKey);

            const getType = (id) => {
                if (!id) return 'model';
                if (id.includes('knowledge--') || id.includes('kb--') || id.includes('concept--')) return 'knowledge';
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
