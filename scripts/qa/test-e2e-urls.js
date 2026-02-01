import { getRouteFromId } from '../../src/utils/mesh-routing-core.js';

const testCases = [
    { id: 'hf-model--meta-llama--Llama-3-8b', expected: '/model/meta-llama/llama-3-8b' },
    { id: 'hf-dataset--meta-llama--Llama-3-8b', expected: '/dataset/meta-llama/llama-3-8b' },
    { id: 'arxiv-paper--2302.13971', expected: '/paper/arxiv/2302.13971' },
    { id: 'gh-agent--auto-gpt--auto-gpt', expected: '/agent/auto-gpt/auto-gpt' },
    { id: 'gh-tool--cli--cli', expected: '/tool/cli/cli' },
    { id: 'hf-space--llava-vl--llava-interactive', expected: '/space/llava-vl/llava-interactive' },
    { id: 'civitai-model--12345', expected: '/model/12345' },
    { id: 'kaggle-dataset--author--dataset', expected: 'https://www.kaggle.com/datasets/author/dataset' },
    { id: 'knowledge--fine-tuning', expected: '/knowledge/fine-tuning' },
    { id: 'concept--machine-learning', expected: '/knowledge/machine-learning' },
    { id: 'report--2026-02-01', expected: '/reports/2026-02-01' },
    // Legacy support
    { id: 'arxiv--2101.00001', expected: '/paper/arxiv/2101.00001' },
    { id: 'github-agent--author--name', expected: '/agent/author/name' },
];

console.log('🧪 Running E2E URL Stability Audit (V1.3)...');

let passed = 0;
for (const tc of testCases) {
    const actual = getRouteFromId(tc.id);
    if (actual === tc.expected) {
        console.log(`✅ [PASS] ${tc.id} -> ${actual}`);
        passed++;
    } else {
        console.log(`❌ [FAIL] ${tc.id}`);
        console.log(`     Expected: ${tc.expected}`);
        console.log(`     Actual:   ${actual}`);
    }
}

console.log(`\n📊 Final Result: ${passed}/${testCases.length} passed.`);
if (passed === testCases.length) {
    process.exit(0);
} else {
    process.exit(1);
}
