// V27.48: derive source_url from entity id when harvest didn't set it.
// Baseline-shard entities (pre-V27 era) often have source_url=null even
// when the id encodes the source platform. Aggregator backfills.

/**
 * Derive a canonical external source URL for known source-type prefixes.
 * Returns null if the id pattern doesn't match a known source.
 * @param {object} entity - entity with id, author, name fields
 * @returns {string|null}
 */
export function deriveSourceUrl(entity) {
    const id = entity?.id || '';
    if (!id) return null;
    // Use explicit author/name when present (faster + handles unusual id shapes)
    const author = entity.author;
    const name = entity.name || entity.displayName;

    // hf-* family → huggingface.co/<owner>/<name>
    if (id.startsWith('hf-')) {
        if (author && name) return `https://huggingface.co/${author}/${name}`;
        // Fallback: parse from id `hf-<type>--<owner>--<name>`
        const m = id.match(/^hf-[a-z]+--([^-][^]*?)--(.+)$/);
        if (m) return `https://huggingface.co/${m[1]}/${m[2]}`;
    }

    // gh-* → github.com/<owner>/<name>
    if (id.startsWith('gh-')) {
        if (author && name) return `https://github.com/${author}/${name}`;
        const m = id.match(/^gh-[a-z]+--([^-][^]*?)--(.+)$/);
        if (m) return `https://github.com/${m[1]}/${m[2]}`;
    }

    // arxiv-paper--<author>--<arxiv-id> → arxiv.org/abs/<arxiv-id>
    if (id.startsWith('arxiv-')) {
        const m = id.match(/^arxiv-[a-z]+--[^-][^]*?--(.+)$/);
        if (m) return `https://arxiv.org/abs/${m[1]}`;
    }

    // replicate-* → replicate.com/<owner>/<name>
    if (id.startsWith('replicate-')) {
        if (author && name) return `https://replicate.com/${author}/${name}`;
        const m = id.match(/^replicate-[a-z]+--([^-][^]*?)--(.+)$/);
        if (m) return `https://replicate.com/${m[1]}/${m[2]}`;
    }

    // ollama-model--<name> (single-segment after prefix)
    if (id.startsWith('ollama-model--')) {
        const m = id.match(/^ollama-model--(.+)$/);
        if (m) return `https://ollama.com/library/${m[1]}`;
    }

    return null;
}
