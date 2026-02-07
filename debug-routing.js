
import { stripPrefix, getRouteFromId } from './src/utils/mesh-routing-core.js';
import { normalizeEntitySlug } from './src/utils/entity-cache-reader-core.js';

const testCases = [
    { id: 'huggingface:deepseek-ai:deepseek-v3', type: 'model' },
    { id: 'huggingface--deepseek-ai--deepseek-v3', type: 'model' },
    { id: 'hf-model--deepseek-ai--deepseek-v3', type: 'model' },
    { id: 'meta/llama-2-13b', type: 'model' },
    { id: 'arxiv:2412.19437', type: 'paper' }
];

console.log("--- Routing & Normalization Audit ---");

testCases.forEach(tc => {
    const slug = stripPrefix(tc.id).replace(/--/g, '/');
    const route = getRouteFromId(tc.id, tc.type);
    const r2FullLocal = normalizeEntitySlug(tc.id, tc.type);

    console.log(`\nInput ID: ${tc.id}`);
    console.log(`Clean Slug: ${slug}`);
    console.log(`Canonical Route: ${route}`);
    console.log(`Normalized R2 Slug: ${r2FullLocal}`);

    // Verification logic
    const pathCorrect = (r2FullLocal === 'deepseek-ai--deepseek-v3' || r2FullLocal === 'meta--llama-2-13b' || r2FullLocal === '2412.19437');
    console.log(`Verification: ${pathCorrect ? '✅ PASS' : '❌ FAIL (Check path resolution)'}`);
});

console.log("\n--- Audit Complete ---");
