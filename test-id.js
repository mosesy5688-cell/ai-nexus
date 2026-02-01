import { normalizeId } from './scripts/utils/id-normalizer.js';

const testIds = [
    'gh-model--astrbotdevs--astrbot',
    'hf-model--gh-model--astrbotdevs--astrbot',
    'hf-space--ai-deadlines',
    'gh-space--my-org--my-space'
];

console.log('--- ID Normalization Test ---');
for (const id of testIds) {
    console.log(`Input:  ${id}`);
    const type = id.includes('space') ? 'space' : 'model';
    console.log(`Result: ${normalizeId(id, 'hf', type)}`);
    console.log('---');
}
