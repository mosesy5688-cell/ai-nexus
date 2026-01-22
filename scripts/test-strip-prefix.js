function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    return id
        .replace(/^(replicate|github|huggingface|hf|arxiv|kb|concept|knowledge|report|paper|model|agent|tool|dataset|space|huggingface_deepspec)[:\-\/]+/, '')
        .replace(/^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|huggingface_deepspec|knowledge|kb|report|arxiv|dataset|tool)--/, '')
        .replace(/:/g, '--')
        .replace(/\//g, '--')
        .toLowerCase();
}

const slug = "huggingface/meta-llama/meta-llama-3-8b-instruct";
const graphId = "replicate:meta/meta-llama-3-8b-instruct";
const canonical = "hf-model--meta-llama--meta-llama-3-8b-instruct";

console.log('Slug:', stripPrefix(slug));
console.log('GraphID:', stripPrefix(graphId));
console.log('Canonical:', stripPrefix(canonical));
