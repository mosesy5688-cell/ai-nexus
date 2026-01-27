import { ArXivAdapter } from './ingestion/adapters/arxiv-adapter.js';
import { AgentsAdapter } from './ingestion/adapters/agents-adapter.js';
import { HuggingFaceAdapter } from './ingestion/adapters/huggingface-adapter.js';
import { GitHubAdapter } from './ingestion/adapters/github-adapter.js';
import { DatasetsAdapter } from './ingestion/adapters/datasets-adapter.js';
import { hasValidCachePath } from './l5/entity-validator.js';
import { stripPrefix, getTypeFromId } from '../src/utils/mesh-routing-core.js';

async function runTests() {
    console.log('🧪 Starting Universal Prefixing V2.0 Verification...\n');

    const tests = [
        {
            name: 'HuggingFace Model',
            adapter: new HuggingFaceAdapter(),
            input: { author: 'deepseek-ai', name: 'deepseek-r1' },
            expectedId: 'hf-model--deepseek-ai--deepseek-r1',
            type: 'model'
        },
        {
            name: 'HuggingFace Space',
            adapter: new HuggingFaceAdapter(),
            input: { author: 'microsoft', name: 'phi-2-demo', isSpace: true },
            expectedId: 'hf-space--microsoft--phi-2-demo',
            type: 'space'
        },
        {
            name: 'GitHub Tool',
            adapter: new GitHubAdapter(),
            input: { author: 'fastapi', name: 'fastapi', type: 'tool' },
            expectedId: 'gh-tool--fastapi--fastapi',
            type: 'tool'
        },
        {
            name: 'GitHub Model',
            adapter: new GitHubAdapter(),
            input: { author: 'meta-llama', name: 'llama-3', type: 'model' },
            expectedId: 'gh-model--meta-llama--llama-3',
            type: 'model'
        },
        {
            name: 'ArXiv Paper',
            adapter: new ArXivAdapter(),
            input: { arxivId: '2401.12345' },
            expectedId: 'arxiv-paper--arxiv--2401.12345',
            type: 'paper'
        },
        {
            name: 'HF Dataset',
            adapter: new DatasetsAdapter(),
            input: { author: 'imagenet', name: 'imagenet-1k' },
            expectedId: 'hf-dataset--imagenet--imagenet-1k',
            type: 'dataset'
        }
    ];

    let passed = 0;

    for (const test of tests) {
        let actualId;
        if (test.name === 'HuggingFace Space') {
            actualId = test.adapter.generateId(test.input.author, test.input.name, 'space');
        } else if (test.name === 'ArXiv Paper') {
            actualId = test.adapter.generateId('arxiv', test.input.arxivId, 'paper');
        } else {
            actualId = test.adapter.generateId(test.input.author, test.input.name, test.input.type);
        }

        const isValid = hasValidCachePath({ id: actualId, source: test.adapter.sourceName });
        const stripped = stripPrefix(actualId);
        const inferredType = getTypeFromId(actualId);

        console.log(`[${test.name}]`);
        console.log(`  Generated ID: ${actualId}`);
        console.log(`  Strip Prefix: ${stripped}`);
        console.log(`  Inferred Type: ${inferredType}`);
        console.log(`  Validator: ${isValid ? '✅ PASS' : '❌ FAIL'}`);

        const idMatch = actualId === test.expectedId;
        const typeMatch = inferredType === test.type;

        if (idMatch && typeMatch && isValid) {
            console.log(`  Overall: ✅ PASS\n`);
            passed++;
        } else {
            console.log(`  Overall: ❌ FAIL (Expected ID: ${test.expectedId})\n`);
        }
    }

    // Test Colon Validation specially
    console.log('🧪 Testing Colon-based Validation (Raw IDs)...');
    const colonTest = hasValidCachePath({ id: 'huggingface:deepseek-ai:deepseek-r1', source: 'huggingface' });
    console.log(`  huggingface:deepseek-ai:deepseek-r1 -> ${colonTest ? '✅ VALID' : '❌ INVALID'}`);

    console.log(`\n🎉 Verification Complete: ${passed}/${tests.length} Standard Tests Passed.`);
}

runTests().catch(console.error);
