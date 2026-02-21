/**
 * Dual-Engine Merger (V19.5 Compliance)
 * Extracted from packet-loader.ts to maintain CES 250-line limit.
 */

export function promoteEngine2Fields(entityPack: any, innerEntity: any, fusedPack: any) {
    const promotedFields = [
        'fni_score', 'fni_percentile', 'fni_commentary', 'fni_metrics',
        'html_readme', 'readme', 'description', 'body_content',
        'mesh_profile', 'relations',
        // V19.5 High-Density Component UI Metrics
        'params_billions', 'context_length', 'downloads', 'stars', 'likes', 'size', 'primary_category', 'pipeline_tag', 'tags'
    ];

    for (const field of promotedFields) {
        const candidateVal = innerEntity[field] !== undefined ? innerEntity[field] : fusedPack[field];
        if (candidateVal !== undefined && candidateVal !== null && candidateVal !== '') {
            const isE1Empty = !entityPack[field] ||
                entityPack[field] === 0 ||
                (Array.isArray(entityPack[field]) && entityPack[field].length === 0) ||
                (typeof entityPack[field] === 'object' && Object.keys(entityPack[field] || {}).length === 0);

            if (isE1Empty) {
                entityPack[field] = candidateVal;
            }
        }
    }

    // Ensure structural integrity
    entityPack.id = entityPack.id || innerEntity.id || fusedPack.id;
    entityPack.type = entityPack.type || innerEntity.type || fusedPack.type;
}
