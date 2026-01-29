import { normalizeId } from './id-normalizer.js';

const tests = [
    {
        name: 'TEST CASE 1: Standard HF Model',
        id: 'meta-llama/Llama-2-7b',
        source: 'huggingface',
        type: 'model',
        expected: 'hf-model--meta-llama--Llama-2-7b'
    },
    {
        name: 'TEST CASE 2: Already Canonical (Idempotency)',
        id: 'hf-model--meta-llama--Llama-2-7b',
        source: 'huggingface',
        type: 'model',
        expected: 'hf-model--meta-llama--Llama-2-7b'
    },
    {
        name: 'TEST CASE 3: ArXiv Paper',
        id: '2312.12345',
        source: 'arxiv',
        type: 'paper',
        expected: 'arxiv--2312.12345'
    },
    {
        name: 'TEST CASE 4: R2 Filename Cleanup',
        id: 'gh-agent--auto-gpt--AutoGPT.json',
        source: 'github',
        type: 'agent',
        expected: 'gh-agent--auto-gpt--AutoGPT'
    }
];

console.log('🧪 Running Identity Standard V2.1 Audit...\n');
let passed = 0;

tests.forEach(t => {
    const result = normalizeId(t.id, t.source, t.type);
    if (result === t.expected) {
        console.log(`✅ [PASS] ${t.name}`);
        passed++;
    } else {
        console.error(`❌ [FAIL] ${t.name}`);
        console.error(`   Actual:   "${result}"`);
        console.error(`   Expected: "${t.expected}"`);
    }
});

console.log(`\n📊 Results: ${passed}/${tests.length} passed.`);
if (passed !== tests.length) {
    process.exit(1);
}
