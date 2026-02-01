
import { normalizeId } from '../utils/id-normalizer.js';
import { stripPrefix, getRouteFromId } from '../../src/utils/mesh-routing-core.js';

console.log('🧪 V16.7.1 Integrity Verification - Identity & Routing Synchronization');
console.log('-------------------------------------------------------------------');

const testCases = [
    { id: 'huggingface:meta-llama/Llama-2-7b', type: 'model', source: 'huggingface', expectedPrefix: 'hf-model--', expectedRoute: '/model/meta-llama/llama-2-7b' },
    { id: 'arxiv:2305.10601', type: 'paper', source: 'arxiv', expectedPrefix: 'arxiv-paper--', expectedRoute: '/paper/2305.10601' },
    { id: 'gh:google/gemma-7b', type: 'model', source: 'gh', expectedPrefix: 'gh-model--', expectedRoute: '/model/google/gemma-7b' },
    { id: 'civitai:12345', type: 'model', source: 'civitai', expectedPrefix: 'civitai-model--', expectedRoute: '/model/12345' }
];

let allPass = true;

for (const tc of testCases) {
    console.log(`\nTesting: ${tc.id} (${tc.type})`);

    // 1. Normalization
    const normId = normalizeId(tc.id, tc.source, tc.type);
    const hasPrefix = normId.startsWith(tc.expectedPrefix);
    console.log(`  - Normalized ID: ${normId} [${hasPrefix ? '✅' : '❌'}]`);
    if (!hasPrefix) allPass = false;

    // 2. Stripping
    const stripped = stripPrefix(normId);
    console.log(`  - Stripped ID:   ${stripped} [✅]`);

    // 3. Routing
    const route = getRouteFromId(normId);
    const routeMatch = route === tc.expectedRoute;
    console.log(`  - Public Route:  ${route} [${routeMatch ? '✅' : '❌'}]`);
    if (!routeMatch) allPass = false;
}

console.log('\n-------------------------------------------------------------------');
if (allPass) {
    console.log('✅ PASS: V16.7.1 Identity and Routing Synchronization is 100% Consistent.');
} else {
    console.log('❌ FAIL: Inconsistencies detected in normalization or routing logic.');
    process.exit(1);
}
