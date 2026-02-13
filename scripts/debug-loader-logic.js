
// Mock imports to simulate environment
const typeMap = {
    'datasets': 'dataset', 'models': 'model', 'agents': 'agent',
    'spaces': 'space', 'tools': 'tool', 'papers': 'paper'
};

const prefixMap = {
    'model': ['hf-model--', 'gh-model--', 'hf--', 'gh--'],
    'dataset': ['hf-dataset--', 'dataset--', 'hf--'],
    'paper': ['arxiv-paper--', 'arxiv--', 'paper--'],
    'space': ['hf-space--', 'space--', 'hf--'],
    'agent': ['gh-agent--', 'hf-agent--', 'agent--'],
    'tool': ['gh-tool--', 'hf-tool--', 'tool--']
};

function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    let result = id.toLowerCase();
    const prefixes = [
        'hf-model--', 'hf-agent--', 'hf-tool--', 'hf-dataset--', 'hf-space--', 'hf-paper--',
        'gh-model--', 'gh-agent--', 'gh-tool--',
        'arxiv-paper--', 'arxiv--',
        'agent--', 'paper--', 'model--', 'tool--', 'space--', 'dataset--'
    ];

    for (const p of prefixes) {
        if (result.startsWith(p)) {
            result = result.slice(p.length);
            break;
        }
    }
    return result.replace(/[:\/]/g, '--').replace(/^--|--$/g, '');
}

function normalizeEntitySlug(id, type = 'model') {
    if (!id) return '';
    let slug = Array.isArray(id) ? id.join('/') : id;
    const base = stripPrefix(slug).replace(/[:\/]/g, '--');
    return base;
}

function getR2PathCandidates(type, normalizedSlug) {
    const singular = typeMap[type] || (type.endsWith('s') ? type.slice(0, -1) : type);
    const lowerSlug = normalizedSlug.toLowerCase();
    const candidates = [];
    const prefixes = prefixMap[singular] || [];

    // Fused
    candidates.push(`cache/fused/${lowerSlug}.json`);
    prefixes.forEach(p => {
        if (!lowerSlug.startsWith(p)) {
            candidates.push(`cache/fused/${p}${lowerSlug}.json`);
        }
    });

    // Entities (Fallback)
    candidates.push(`cache/entities/${lowerSlug}.json`);
    candidates.push(`cache/entities/${singular}/${lowerSlug}.json`);

    prefixes.forEach(mandatoryPrefix => {
        if (!lowerSlug.startsWith(mandatoryPrefix)) {
            const prefixedSlug = `${mandatoryPrefix}${lowerSlug}`;
            candidates.push(`cache/entities/${prefixedSlug}.json`);
            candidates.push(`cache/entities/${singular}/${prefixedSlug}.json`);
        }
    });

    return candidates;
}

// TEST CASES
console.log('--- Agent Test ---');
const agentSlug = 'AutoGPT';
const normAgent = normalizeEntitySlug(agentSlug, 'agent');
console.log(`Slug: ${agentSlug} -> Normalized: ${normAgent}`);
console.log('Candidates:', getR2PathCandidates('agent', normAgent));

console.log('\n--- Paper Test 1 (Plain ID) ---');
const paperSlug1 = '2310.06825';
const normPaper1 = normalizeEntitySlug(paperSlug1, 'paper');
console.log(`Slug: ${paperSlug1} -> Normalized: ${normPaper1}`);
console.log('Candidates:', getR2PathCandidates('paper', normPaper1));

console.log('\n--- Paper Test 2 (ArXiv Prefix) ---');
const paperSlug2 = 'arxiv/2310.06825';
const normPaper2 = normalizeEntitySlug(paperSlug2, 'paper');
console.log(`Slug: ${paperSlug2} -> Normalized: ${normPaper2}`);
console.log('Candidates:', getR2PathCandidates('paper', normPaper2));

console.log('\n--- Model Test (Slash) ---');
const modelSlug = 'google/gemma-2-9b';
const normModel = normalizeEntitySlug(modelSlug, 'model');
console.log(`Slug: ${modelSlug} -> Normalized: ${normModel}`);
console.log('Candidates:', getR2PathCandidates('model', normModel));
