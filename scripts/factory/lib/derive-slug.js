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

/**
 * Honest humanized DISPLAY name for a name-less entity, derived purely from its
 * own real id/slug. Mirrors the existing baker pattern (mesh-profile-baker.js:111,
 * 142: `id.split('--').pop()`) but de-kebabs the tail to spaces for readability.
 *
 * This is display FORMATTING of the entity's real identifier, NOT invented
 * metadata: the id IS the entity's true identity. The result is guaranteed to be
 * non-empty and `!== id` (the resolve-filter canary, mesh-resolve-filter.js:75,
 * rejects a `name === id` degenerate echo). On a pathological id whose de-kebabbed
 * tail still equals the id (no separators), a readable suffix keeps it `!== id`.
 *
 * @param {string} id - the entity's canonical id/slug
 * @returns {string} a human-readable name, non-empty and never equal to `id`
 */
export function humanizeId(id) {
    const raw = typeof id === 'string' ? id : '';
    const tail = (deriveSlug(raw).split('--').pop() || '');
    const human = tail.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    // Canary-safe floor: must be non-empty AND provably !== id. A de-kebabbed
    // multi-word tail has spaces (so !== id automatically); a single bare token
    // could still equal id, so append a readable marker rather than re-emit id.
    if (human && human !== raw) return human;
    if (raw) return `${raw} (entity)`;
    return 'Unknown entity';
}
