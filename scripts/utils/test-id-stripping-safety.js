/**
 * ID Normalization Safety Test Suite (V2.1.2)
 */
import { normalizeId } from './id-normalizer.js';

const TEST_CASES = [
    { id: 'hf-model--google--gemma-7b', expected: 'hf-model--google--gemma-7b', note: 'Standard HP prefix preservation' },
    { id: 'model--google--gemma-7b', expected: 'hf-model--google--gemma-7b', note: 'Implicit type upgrade' },
    { id: 'hf-model--model--llama-3', expected: 'hf-model--model--llama-3', note: 'Author "model" protection (NO double stripping)' },
    { id: 'google/gemma-7b', expected: 'hf-model--google--gemma-7b', note: 'Slash to dual-dash plus default prefix' },
    { id: 'gh-tool--vllm--vllm', expected: 'gh-tool--vllm--vllm', note: 'V2.1 Tool prefix preservation' },
    { id: 'gh-tool--gh-tool--vllm', expected: 'gh-tool--gh-tool--vllm', note: 'Recursive safety (Prevent multi-stripping of valid names)' }
];

console.log('🧪 Starting ID Normalization Safety Tests...\n');

let passedCount = 0;
for (const tc of TEST_CASES) {
    const result = normalizeId(tc.id);
    const passed = result === tc.expected;
    console.log(`${passed ? '✅' : '❌'} [${tc.note}]`);
    console.log(`   Input:    ${tc.id}`);
    console.log(`   Output:   ${result}`);
    if (!passed) console.log(`   Expected: ${tc.expected}`);
    console.log('');
    if (passed) passedCount++;
}

console.log(`\n📊 SUMMARY: ${passedCount}/${TEST_CASES.length} Tests Passed.`);
if (passedCount < TEST_CASES.length) process.exit(1);
