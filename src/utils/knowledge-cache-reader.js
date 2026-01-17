// Knowledge Cache Reader (V15.15)
// Art 5.1 Compliance: Extracted from entity-cache-reader-core.js

/**
 * V15.15 Universal Mesh Relations Aggregator
 * Fetches and merges relations from multiple fragmented R2 sources on-the-fly.
 */
export async function fetchMeshRelations(locals, filterEntityId = null) {
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    const sources = [
        'cache/relations/explicit.json',
        'cache/relations.json', // Legacy fallback
        'cache/relations/knowledge-links.json',
        'cache/relations/alt-by-category/alt-base.json'
    ];

    let allRelations = [];
    const seen = new Set();

    if (r2) {
        const fetchPromises = sources.map(async (path) => {
            try {
                const file = await r2.get(path);
                if (file) {
                    const data = await file.json();
                    // V15: Support "edges" property from adjacency list, OR "relations" (legacy), OR flat array
                    return data.edges || data.relations || (Array.isArray(data) ? data : []);
                }
            } catch (e) {
                console.warn(`[MeshAggregator] Failed to fetch ${path}:`, e.message);
            }
            return [];
        });

        const results = await Promise.all(fetchPromises);
        results.forEach(data => {
            // If it's the V15 adjacency list format (object with source_id keys)
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                Object.entries(data).forEach(([source_id, links]) => {
                    if (Array.isArray(links)) {
                        links.forEach(link => {
                            // Link format: [target_id, relation_type, confidence]
                            if (Array.isArray(link) && link.length >= 2) {
                                allRelations.push({
                                    source_id,
                                    target_id: link[0],
                                    relation_type: link[1],
                                    confidence: (link[2] || 100) / 100
                                });
                            } else if (link && typeof link === 'object') {
                                // Fallback for mixed formats
                                allRelations.push({
                                    source_id: link.source_id || source_id,
                                    target_id: link.target_id,
                                    relation_type: link.relation_type || 'RELATED',
                                    confidence: link.confidence || 1.0
                                });
                            }
                        });
                    }
                });
            } else if (Array.isArray(data)) {
                // Legacy flat array format
                data.forEach(rel => {
                    const sourceId = rel.source_id || rel.source || rel.from;
                    const targetId = rel.target_id || rel.target || rel.to;
                    if (!sourceId || !targetId) return;

                    const key = `${sourceId}|${targetId}|${rel.relation_type || rel.type || 'RELATED'}`;
                    if (!seen.has(key)) {
                        allRelations.push(rel);
                        seen.add(key);
                    }
                });
            }
        });
    }

    const relations = [];
    const filterNormalized = filterEntityId ? filterEntityId.toLowerCase().replace(/[:/]/g, '--') : null;

    for (const obj of allRelations) {
        const source = obj.source_id || obj.source || obj.from;
        const target = obj.target_id || obj.target || obj.to;
        if (!source || !target) continue;

        const normalizedSource = source.toLowerCase().replace(/[:/]/g, '--');
        const normalizedTarget = target.toLowerCase().replace(/[:/]/g, '--');

        const sourceMatches = filterNormalized && (normalizedSource === filterNormalized || normalizedSource.endsWith('--' + filterNormalized));
        const targetMatches = filterNormalized && (normalizedTarget === filterNormalized || normalizedTarget.endsWith('--' + filterNormalized));

        if (filterNormalized && !sourceMatches && !targetMatches) {
            continue;
        }

        let relType = obj.type || obj.relation_type || 'RELATED';
        let sourceType = obj.source_type || obj.from_type || 'entity';
        let targetType = obj.target_type || obj.to_type || 'entity';

        if (normalizedSource.includes('concept--')) sourceType = 'concept';
        if (normalizedTarget.includes('concept--')) targetType = 'concept';
        if (normalizedSource.includes('report--')) sourceType = 'report';
        if (normalizedTarget.includes('report--')) targetType = 'report';

        relations.push({
            source_id: source,
            target_id: target,
            type: relType,
            source_type: sourceType,
            target_type: targetType,
            metadata: obj.metadata || {}
        });
    }

    return relations;
}

/**
 * Fetch Concept/Article Metadata for node enrichment (V15.15)
 */
export async function fetchConceptMetadata(locals) {
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    try {
        if (r2) {
            const file = await r2.get('cache/knowledge/index.json');
            if (file) {
                const data = await file.json();
                return data.articles || data;
            }
        }
    } catch (e) {
        console.warn('[ConceptReader] Failed to fetch knowledge index:', e.message);
    }
    return [];
}
