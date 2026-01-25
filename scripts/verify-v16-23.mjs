/**
 * V16.23 Trend Mapping Audit
 * Verifies that frontend IDs correctly resolve to R2 trend-data.json keys.
 */

// Mock production data slice
const mockR2Data = {
    "hf-dataset--deepmind--code_contests": { scores: [29.5] },
    "replicate:meta/llama-2-70b-chat": { scores: [16.2] },
    "microsoft/phi-2": { scores: [17.3] }
};

const testIds = [
    'replicate--meta/llama-2-70b-chat', // Current frontend pattern
    'model--replicate--meta/llama-2-70b-chat', // Full UMID pattern
    'hf-dataset--deepmind--code_contests',
    'microsoft/phi-2'
];

console.log("=== V16.23 Trend Alignment Audit ===");

testIds.forEach(id => {
    let resolvedId = id;

    if (!mockR2Data[resolvedId]) {
        const cleanId = id.replace(/^(model|agent|dataset|paper|space|tool)--/, '')
            .replace(/^(model|agent|dataset|paper|space|tool)-/, '');
        const altIds = [
            id.replace(/\//g, '--'),
            id.replace(/--/g, '/'),
            id.replace('--', ':'),
            cleanId,
            cleanId.replace(/\//g, '--'),
            cleanId.replace(/--/g, '/'),
            cleanId.replace(/--/g, ':'),
            `hf-model--${cleanId.replace(/\//g, '--')}`,
            `replicate:${cleanId}`,
            `replicate:${cleanId.replace(/--/g, '/')}`
        ];

        for (const alt of altIds) {
            if (mockR2Data[alt]) {
                resolvedId = alt;
                break;
            }
        }
    }

    if (mockR2Data[resolvedId]) {
        console.log(`[PASS] Result: ${id} -> ${resolvedId} (${mockR2Data[resolvedId].scores[0]})`);
    } else {
        console.log(`[FAIL] Result: ${id} -> NOT FOUND`);
    }
});

console.log("=== Audit Complete ===");
