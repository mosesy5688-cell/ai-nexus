
// src/utils/builders/markdown-utils.js
import { marked } from 'marked';

// Safely render markdown to HTML
export function renderMarkdown(markdown) {
    if (!markdown) return '';
    try {
        // Simple sanitization or config could go here
        return marked.parse(String(markdown));
    } catch (e) {
        console.warn('Markdown render error', e);
        return String(markdown);
    }
}
