/**
 * V26.4 Abstract Cleaner — Phase 6 A3 Cold/Hot Separation
 * Extracts clean natural-language summary from raw body_content,
 * stripping YAML frontmatter, code blocks, HTML, markdown markers.
 */

export function cleanAbstract(body, maxLen = 500) {
    if (!body) return '';
    return body
        .replace(/^---[\s\S]*?---\s*/m, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[#*`\[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}
