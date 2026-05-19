/**
 * Slug normalization + multi-form ID candidate generation.
 *
 * Shared between /api/v1/entity/[...id].ts and /api/v1/compare.ts — both
 * endpoints need to map an Agent-provided ID (which may be HF-native
 * `author/name`, bare `name`, internal canonical `hf-model--author--name`,
 * uppercase/mixed case, or slug form) to the canonical lookup keys stored
 * in meta-NN.db.
 *
 * Extracted from entity/[...id].ts + compare.ts (V27.22 dedup) to:
 *   - keep entity/[...id].ts under the 250-line CES monolith cap
 *   - eliminate the literal SLUG_PREFIXES + deriveSlug duplication that
 *     drifted between the two files
 */

export const SLUG_PREFIXES = [
    'hf-model', 'hf-agent', 'hf-tool', 'hf-dataset', 'hf-space', 'hf-paper', 'hf-collection',
    'gh-model', 'gh-agent', 'gh-tool', 'gh-repo',
    'arxiv-paper', 'arxiv', 'paper',
    'replicate-model', 'replicate-agent', 'replicate-space',
    'civitai-model', 'ollama-model', 'kaggle-dataset', 'kaggle-model',
    'langchain-prompt', 'langchain-agent',
    'knowledge', 'concept', 'report', 'dataset', 'model', 'agent', 'tool', 'space', 'prompt',
];

/** Auto-prepended prefixes when input has no recognized prefix. */
const AUTO_PREFIXES = ['hf-model', 'gh-model', 'gh-tool', 'arxiv-paper', 'replicate-model',
    'hf-dataset', 'kaggle-model', 'civitai-model', 'ollama-model'];

/**
 * Strip recognized source prefix and normalize separators to `--`.
 * Example: `hf-model--meta-llama/Llama-3-8B` → `meta-llama--llama-3-8b`
 */
export function deriveSlug(id: string): string {
    let r = (id || '').toLowerCase();
    for (const p of SLUG_PREFIXES) {
        if (r.startsWith(`${p}--`) || r.startsWith(`${p}:`) || r.startsWith(`${p}/`)) {
            r = r.slice(p.length + (r[p.length] === '-' ? 2 : 1));
            break;
        }
    }
    return r.replace(/[:\/]/g, '--').replace(/^--|--$/g, '').replace(/--+/g, '--');
}

/**
 * Generate candidate id/slug variants from a raw user input. Agents rarely
 * know the internal `hf-model--<author>--<name>` form; they typically know
 * the HuggingFace-native `author/name` form, or just `name`, or upper/mixed
 * case. Producing multiple candidates and matching any of them via SQL IN()
 * makes the endpoint tolerant of these forms without forcing an extra
 * roundtrip through /search first.
 */
export function generateCandidates(rawId: string): string[] {
    const lower = rawId.toLowerCase();
    const candidates = new Set<string>();
    candidates.add(lower);
    candidates.add(lower.replace(/\//g, '--').replace(/--+/g, '--'));
    const slug = deriveSlug(rawId);
    if (slug) candidates.add(slug);
    const hasPrefix = SLUG_PREFIXES.some(p =>
        lower.startsWith(`${p}--`) || lower.startsWith(`${p}:`) || lower.startsWith(`${p}/`)
    );
    if (!hasPrefix && slug) {
        for (const p of AUTO_PREFIXES) candidates.add(`${p}--${slug}`);
    }
    return [...candidates].filter(Boolean);
}
