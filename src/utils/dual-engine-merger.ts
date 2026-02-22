/**
 * Dual-Engine Merger (V19.5 Compliance)
 * Extracted from packet-loader.ts to maintain CES 250-line limit.
 */

export function promoteEngine2Fields(entityPack: any, innerEntity: any, fusedPack: any) {
    const promotedFields = [
        'fni_score', 'fni_percentile', 'fni_commentary', 'fni_metrics',
        'fni_p', 'fni_v', 'fni_c', 'fni_u',
        'html_readme', 'readme', 'description', 'body_content',
        'mesh_profile', 'relations',
        // V19.5 High-Density Component UI Metrics
        'params_billions', 'context_length', 'downloads', 'stars', 'likes', 'size', 'primary_category', 'pipeline_tag', 'tags'
    ];

    for (const field of promotedFields) {
        const candidateVal = innerEntity[field] !== undefined ? innerEntity[field] : fusedPack[field];
        if (candidateVal !== undefined && candidateVal !== null && candidateVal !== '') {
            const currentVal = entityPack[field];

            const isE1Empty = !currentVal ||
                currentVal === 0 ||
                (Array.isArray(currentVal) && currentVal.length === 0) ||
                (typeof currentVal === 'object' && Object.keys(currentVal || {}).length === 0);

            // V21.15.3: "Longest Wins" Strategy for text descriptions
            const isTextField = ['html_readme', 'readme', 'description', 'body_content'].includes(field);
            const isSignificantlyBetter = isTextField &&
                typeof candidateVal === 'string' &&
                typeof currentVal === 'string' &&
                candidateVal.length > currentVal.length * 1.5;

            if (isE1Empty || isSignificantlyBetter) {
                entityPack[field] = candidateVal;
                if (isSignificantlyBetter) console.log(`[Merger] Promoted better content for ${field} (${currentVal.length} -> ${candidateVal.length})`);
            }
        }
    }

    // Ensure structural integrity
    entityPack.id = entityPack.id || innerEntity.id || fusedPack.id;
    entityPack.type = entityPack.type || innerEntity.type || fusedPack.type;
}
