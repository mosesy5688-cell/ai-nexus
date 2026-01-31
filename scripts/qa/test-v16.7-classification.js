
import { getV6Category } from '../factory/lib/category-stats-generator.js';

const testCases = [
    { id: 'google/bert-base-uncased', name: 'BERT Base', tags: ['feature-extraction'], expected: 'knowledge-retrieval' },
    { id: 'BAAI/bge-large-en', name: 'BGE Large English', tags: [], expected: 'knowledge-retrieval' },
    { id: 'CompVis/stable-diffusion-v1-4', name: 'Stable Diffusion', tags: [], expected: 'vision-multimedia' },
    { id: 'openai/whisper-large-v3', name: 'Whisper Large v3', tags: [], expected: 'vision-multimedia' },
    { id: 'microsoft/DialoGPT-medium', name: 'DialoGPT', tags: [], expected: 'text-generation' }, // Existing fallback
    { id: 'THUDM/agentlm-7b', name: 'AgentLM', tags: [], expected: 'automation-workflow' },
    { id: 'meta-llama/Llama-2-7b-chat-hf', name: 'Llama 2', pipeline_tag: 'text-generation', expected: 'text-generation' }
];

console.log('🧪 V16.7 Shadow Classification Audit');
console.log('====================================');

let passed = 0;
for (const tc of testCases) {
    const result = getV6Category(tc);
    const status = result === tc.expected ? '✅ PASS' : `❌ FAIL (Got: ${result})`;
    console.log(`- Entity: ${tc.id.padEnd(30)} | Expected: ${tc.expected.padEnd(20)} | Result: ${status}`);
    if (result === tc.expected) passed++;
}

console.log('====================================');
console.log(`Summary: ${passed}/${testCases.length} core test cases passed.`);

if (passed === testCases.length) {
    console.log('🚀 Tier-3 Pattern Inference is operational.');
} else {
    process.exit(1);
}
