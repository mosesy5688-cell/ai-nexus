/**
 * text-sanitizer.js
 * Robust text cleaning for AI entity descriptions.
 * Removes Markdown, HTML, and long URLs.
 */

// V27 sweep-1 (c): internal source-prefix tokens that leak into citation text
// as raw storage keys (paper AND non-paper). Used to build the noise-stripping
// regex below; kept as a list so the set is auditable and stays in sync with
// the SPEC-ID-V2.1 prefixes in mesh-routing-core.stripPrefix.
const INTERNAL_KEY_PREFIXES = [
    'arxiv-paper', 'arxiv', 'hf-paper', 'paper',
    'hf-model', 'hf-agent', 'hf-tool', 'hf-dataset', 'hf-space', 'hf-collection',
    'gh-model', 'gh-agent', 'gh-tool', 'gh-repo',
    'replicate-model', 'replicate-agent', 'replicate-space',
    'civitai-model', 'ollama-model', 'kaggle-dataset', 'kaggle-model',
    'langchain-prompt', 'langchain-agent',
    'model', 'agent', 'tool', 'space', 'dataset', 'prompt', 'report', 'knowledge', 'unknown',
];
// Matches `<prefix>--`, `<prefix>__` (bibtex underscore-mangled) or `<prefix>:`
// anywhere in the text. Sorted longest-first so e.g. `arxiv-paper` wins over
// `arxiv` and the longer key is fully consumed. A prefix's own internal `-`
// may also surface as `_` after bibtex separator-mangling (hf-model -> hf_model),
// so each prefix `-` is matched as `[-_]`.
const INTERNAL_KEY_RE = new RegExp(
    '(?:' + INTERNAL_KEY_PREFIXES.slice()
        .sort((a, b) => b.length - a.length)
        .map(p => p.replace(/-/g, '[-_]'))
        .join('|') + ')(?:[-_]{2}|:)',
    'gi'
);
// Embedded internal route URLs (absolute or relative) for the public entity
// routes — these carry the raw id and are noise inside a citation string.
const INTERNAL_ROUTE_RE = new RegExp(
    '(?:https?:\\/\\/[^\\s\\/]*free2aitools\\.com)?\\/(?:model|models|agent|agents|tool|tools|space|spaces|dataset|datasets|paper|papers|prompt|prompts|reports|knowledge)\\/[^\\s\\)\\]]+',
    'gi'
);

/**
 * V27.A7 (R7) + V27 sweep-1 (c): Strip internal storage-key noise from a
 * citation string so Agents ingest a clean citation (north-star: purest
 * evidence chain). Removes: bracketed internal keys (`[f2ai-...]`); raw
 * source-prefix key tokens for BOTH papers and non-papers (`arxiv-paper--`,
 * `unknown--`, `hf-model--`, `gh-tool--`, generic `<type>--`/`<type>:` and
 * their bibtex `__` variants); and embedded internal route URLs
 * (`/papers/<id>`, `/model/<id>`, free2aitools.com/<route>/<id>). Pure no-op
 * when no internal noise is present (already-clean citations). Strips only
 * existing noise; never invents citation content.
 */
export function sanitizeCitation(text) {
    if (typeof text !== 'string' || !text) return text || null;
    return text
        .replace(/\[f2ai-[^\]]*\]/gi, '')
        .replace(INTERNAL_ROUTE_RE, '')
        .replace(INTERNAL_KEY_RE, '')
        .replace(/\{\s*,/g, '{')
        .replace(/\s+/g, ' ')
        .trim();
}

export function cleanDescription(text) {
    if (!text) return '';
    return text
        // V21.15.8: Hardened YAML frontmatter stripping (handles multiple trailing newlines)
        .replace(/^[\s\n]*---\s*[\s\S]*?---\s*\n*/g, '')
        // Remove HTML tags
        .replace(/<[^>]*>?/gm, '')
        // Remove Markdown images ![alt](url)
        .replace(/!\[.*?\]\(.*?\)/g, '')
        // Remove Markdown links [text](url) -> text
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        // Remove raw long URLs
        .replace(/https?:\/\/[^\s]{30,}/g, '')
        // Remove specific common clutter artifacts
        .replace(/!GitHub repo size|!Harbor Ko-fi/gi, '')
        // Clean up whitespace
        .replace(/\s+/g, ' ')
        .trim();
}
