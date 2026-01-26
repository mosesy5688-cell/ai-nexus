
import { stripPrefix, isMatch } from './src/utils/knowledge-cache-reader.js';

function test(a, b) {
    console.log(`Matching: [${a}] vs [${b}]`);
    console.log(`   Norm A: ${stripPrefix(a)}`);
    console.log(`   Norm B: ${stripPrefix(b)}`);
    console.log(`   isMatch: ${isMatch(a, b)}`);
}

console.log("--- Current Normalization Logic Audit ---");
test('replicate:meta/meta-llama-3-70b-instruct', 'hf-model--meta-llama--llama-3-70b-instruct');
test('replicate:meta/meta-llama-3-70b-instruct', 'meta/meta-llama-3-70b-instruct');
test('huggingface_deepspec--meta-llama--llama-3-70b-instruct', 'meta-llama/llama-3-70b-instruct');

// Expected result should be TRUE for all. Currently it's likely FALSE due to 'meta' vs 'meta-llama' mismatch.
