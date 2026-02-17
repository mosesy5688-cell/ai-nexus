import { getRouteFromId, getTypeFromId } from './src/utils/mesh-routing-core.js';

const testCases = [
    { id: 'hf-model--meta-llama--llama-3-8b', expected: '/model/meta-llama/llama-3-8b' },
    { id: 'hf-paper--2404.14219', expected: '/paper/2404.14219' },
    { id: 'arxiv--2404.14219', expected: '/paper/2404.14219' },
    { id: 'kaggle-model--google--gemma--2', expected: '/model/google/gemma/2' },
    { id: 'replicate-model--meta--llama-2-70b', expected: '/model/meta/llama-2-70b' },
    { id: 'knowledge--moe', expected: '/knowledge/moe' },
    { id: 'gh-agent--open-webui--open-webui', expected: '/agent/open-webui/open-webui' },
    { id: 'hf-dataset--glue', expected: '/dataset/glue' }
];

function runTests() {
    console.log("🧪 Testing Mesh Routing Utility...");
    let passCount = 0;

    for (const tc of testCases) {
        const route = getRouteFromId(tc.id);
        if (route === tc.expected) {
            console.log(`✅ [PASS] ${tc.id} -> ${route}`);
            passCount++;
        } else {
            console.error(`❌ [FAIL] ${tc.id} -> Expected: ${tc.expected}, Got: ${route}`);
        }
    }

    console.log(`\nResults: ${passCount}/${testCases.length} passed.`);
    if (passCount !== testCases.length) process.exit(1);
}

runTests();
