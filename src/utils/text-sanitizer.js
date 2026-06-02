/**
 * text-sanitizer.js
 * Robust text cleaning for AI entity descriptions.
 * Removes Markdown, HTML, and long URLs.
 */

/**
 * V27.A7 (R7): Strip internal storage-key noise from a citation string so
 * Agents ingest a clean academic citation (north-star: purest evidence chain).
 * Removes raw key prefixes (`arxiv-paper--`, `unknown--`) and their bibtex
 * underscore-mangled variants (`arxiv_paper__`, `unknown__`), and bracketed
 * internal keys (`[f2ai-...]`). Pure no-op when no internal noise is present
 * (non-paper / already-clean citations). Strips only existing noise; never
 * invents citation content.
 */
export function sanitizeCitation(text) {
    if (typeof text !== 'string' || !text) return text || null;
    return text
        .replace(/\[f2ai-[^\]]*\]/gi, '')
        .replace(/arxiv[-_]paper[-_]{1,2}/gi, '')
        .replace(/unknown[-_]{1,2}/gi, '')
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
