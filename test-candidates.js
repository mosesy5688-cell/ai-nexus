function getR2PathCandidates(type, normalizedSlug) {
    const typeMap = {
        'datasets': 'dataset', 'models': 'model', 'agents': 'agent',
        'spaces': 'space', 'tools': 'tool', 'papers': 'paper'
    };
    const singular = typeMap[type] || (type.endsWith('s') ? type.slice(0, -1) : type);
    const lowerSlug = normalizedSlug.toLowerCase();

    const prefixMap = {
        'model': [
            'hf-model--', 'gh-model--', 'huggingface--', 'github--',
            'civitai--', 'ollama--', 'replicate--', 'kaggle--', 'hf--', 'gh--'
        ],
        'agent': ['gh-agent--', 'hf-agent--', 'github--', 'huggingface--', 'agent--']
    };
    const prefixes = prefixMap[singular] || [];

    const candidates = [];

    prefixes.forEach(p => {
        const prefixed = lowerSlug.startsWith(p) ? lowerSlug : `${p}${lowerSlug}`;
        candidates.push(`cache/fused/${prefixed}.json.gz`);
    });

    return [...new Set(candidates)];
}

// Test with short Google SEO URL: /agent/microsoft/autogen
const slugFromUrl = 'microsoft--autogen'; // after sanitize
console.log(getR2PathCandidates('agent', slugFromUrl));
