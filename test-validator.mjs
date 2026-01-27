import { hasValidCachePath } from './scripts/l5/entity-validator.js';

const testCases = [
    { id: 'huggingface:deepseek-ai:deepseek-r1', source: 'huggingface' },
    { id: 'replicate:google/gemini', source: 'replicate' },
    { id: 'hf-dataset--huggingface--badges', source: 'huggingface' },
    { id: 'huggingface:meta-llama/Llama-2-7b-chat-hf', source: 'huggingface' }
];

testCases.forEach(tc => {
    console.log(`${tc.id}: ${hasValidCachePath(tc)}`);
});
