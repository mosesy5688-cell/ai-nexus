/**
 * text-sanitizer.js
 * Robust text cleaning for AI entity descriptions.
 * Removes Markdown, HTML, and long URLs.
 */

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
