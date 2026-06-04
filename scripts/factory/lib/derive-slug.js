// Slug derivation for entities lacking an explicit slug.
// Extracted from pack-db.js (CES Art 5.1 monolith ceiling). Pure: strips a
// known source prefix then normalizes separators to the canonical `--` form.

const SLUG_PREFIXES = [
    'hf-model', 'hf-agent', 'hf-tool', 'hf-dataset', 'hf-space', 'hf-paper', 'hf-collection',
    'gh-model', 'gh-agent', 'gh-tool', 'gh-repo',
    'arxiv-paper', 'arxiv', 'paper',
    'replicate-model', 'replicate-agent', 'replicate-space',
    'civitai-model', 'ollama-model',
    'kaggle-dataset', 'kaggle-model',
    'langchain-prompt', 'langchain-agent',
    'knowledge', 'concept', 'report', 'dataset', 'model', 'agent', 'tool', 'space', 'prompt'
];

export function deriveSlug(id) {
    let r = (id || '').toLowerCase();
    for (const p of SLUG_PREFIXES) {
        if (r.startsWith(`${p}--`) || r.startsWith(`${p}:`) || r.startsWith(`${p}/`)) {
            r = r.slice(p.length + (r[p.length] === '-' ? 2 : 1)); break;
        }
    }
    return r.replace(/[:\/]/g, '--').replace(/^--|--$/g, '').replace(/--+/g, '--');
}
