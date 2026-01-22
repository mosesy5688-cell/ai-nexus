function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    let result = id.toLowerCase();

    const prefixes = /^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|huggingface_deepspec|knowledge|kb|report|arxiv|dataset|tool|replicate|github|huggingface|concept|paper|model|agent|space|hf)[:\-\/]+/;

    result = result.replace(prefixes, '');
    result = result.replace(prefixes, ''); // Double pass for things like replicate:meta/

    return result
        .replace(/:/g, '--')
        .replace(/\//g, '--');
}

const slug = "huggingface/meta-llama/meta-llama-3-8b-instruct";
const graphId = "replicate:meta/meta-llama-3-8b-instruct";
const canonical = "hf-model--meta-llama--meta-llama-3-8b-instruct";
const nested = "replicate:meta:meta-llama-3-8b-instruct";

console.log('Slug:', stripPrefix(slug));
console.log('GraphID:', stripPrefix(graphId));
console.log('Canonical:', stripPrefix(canonical));
console.log('Nested:', stripPrefix(nested));
