// Knowledge Cache Reader (V15.16)
// Corrected: Zero-Runtime Static Shard Strategy

/**
 * Normalizes entity IDs to facilitate flexible matching.
 * Handles production prefixes like replicate:, hf-model--, etc.
 */
function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    return id
        .replace(/^(replicate|github|huggingface|hf|arxiv|kb|concept|paper|model|agent|tool|dataset|space|huggingface_deepspec)[:\-]+/, '')
        .replace(/^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|huggingface_deepspec)--/, '')
        .replace(/--/g, '/')
        .toLowerCase();
}

/**
 * Fetch Mesh Relations with performance gating for SSR.
 */
export async function fetchMeshRelations(locals, entityId = null, options = { ssrOnly: true }) {
    const R2 = locals?.runtime?.env?.R2_ASSETS;
    if (!R2) return [];

    const target = stripPrefix(entityId);
    let allRelations = [];

    // Sources prioritized by performance & actual R2 structure (verified 17 Jan)
    const smallSources = [
        'cache/relations.json',           // 74KB - Legacy fallback (15 Jan)
        'cache/relations/explicit.json',  // 3.1MB - Latest structural relations (17 Jan)
    ];

    const sideSources = [
        'cache/relations/knowledge-links.json' // 3.25MB - Keyword-based semantic links (17 Jan)
    ];

    // V16: SSR must load core relations even if 'heavy' to ensure bidirectional mesh on first paint
    const sourcesToFetch = [...smallSources, ...sideSources];

    try {
        for (const key of sourcesToFetch) {
            try {
                const obj = await R2.get(key);
                if (!obj) continue;

                const data = await obj.json();

                // Handle V15 Adjacency List (explicit.json)
                if (data.edges && typeof data.edges === 'object' && !Array.isArray(data.edges)) {
                    Object.entries(data.edges).forEach(([srcId, targets]) => {
                        if (Array.isArray(targets)) {
                            targets.forEach(edge => {
                                // edge format: [target_id, type, confidence]
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
                // Handle V14 Flat Array or relations.json optimized format
                else if (Array.isArray(data.relations)) {
                    allRelations = allRelations.concat(data.relations);
                }
                // Handle knowledge-links.json format
                else if (Array.isArray(data.links)) {
                    data.links.forEach(link => {
                        if (link.entity_id && Array.isArray(link.knowledge)) {
                            link.knowledge.forEach(k => {
                                allRelations.push({
                                    source_id: link.entity_id,
                                    target_id: typeof k === 'string' ? `concept--${k}` : `concept--${k.slug}`,
                                    relation_type: 'EXPLAIN',
                                    confidence: k.confidence || 1.0
                                });
                            });
                        }
                    });
                }
            } catch (innerError) {
                console.warn(`[KnowledgeReader] Failed to parse ${key}:`, innerError.message);
            }
        }

        // Processing & Sanitizing
        const filtered = [];
        const seen = new Set();

        for (const rel of allRelations) {
            const sid = rel.source_id;
            const tid = rel.target_id;
            if (!sid || !tid) continue;

            const normS = stripPrefix(sid);
            const normT = stripPrefix(tid);

            // Filter by target if requested
            if (target && normS !== target && normT !== target) continue;

            const dupKey = `${sid}|${tid}|${rel.relation_type}`;
            if (seen.has(dupKey)) continue;
            seen.add(dupKey);

            filtered.push({
                source_id: sid,
                target_id: tid,
                relation_type: rel.relation_type || 'RELATED',
                confidence: rel.confidence || 0.8,
                source_type: sid.includes('concept--') ? 'concept' : (sid.includes('report--') ? 'report' : 'model'),
                target_type: tid.includes('concept--') ? 'concept' : (tid.includes('report--') ? 'report' : 'model')
            });
        }

        return filtered;
    } catch (e) {
        console.error('[KnowledgeReader] Global Error:', e);
        return [];
    }
}

/**
 * Concept metadata fetcher
 */
export async function fetchConceptMetadata(locals) {
    const R2 = locals?.runtime?.env?.R2_ASSETS;
    if (!R2) return [];

    try {
        const file = await R2.get('cache/knowledge/index.json');
        if (file) {
            const data = await file.json();
            // Strict check: data must be array OR have .articles array
            const list = data?.articles || (Array.isArray(data) ? data : []);
            if (Array.isArray(list) && list.length > 0) return list;
        }

        // Fallback for MMLU/HumanEval if index.json is missing or invalid
        return [
            { id: 'concept--mmlu', title: 'MMLU Benchmark', slug: 'mmlu', icon: '🧪' },
            { id: 'concept--humaneval', title: 'HumanEval', slug: 'humaneval', icon: '💻' }
        ];
    } catch (e) {
        console.warn('[KnowledgeReader] Concept fetch failed, using minimal fallback');
        return [
            { id: 'concept--mmlu', title: 'MMLU Benchmark', slug: 'mmlu', icon: '🧪' }
        ];
    }
}
