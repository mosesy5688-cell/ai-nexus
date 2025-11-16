// File: src/components/markdown.js 

import { marked } from 'marked'; 

/**
 * Compiles a raw Markdown string into its final HTML output.
 * @param {string} markdownString - The raw Markdown content to compile.
 * @returns {string} The compiled HTML string.
 */
export function renderMarkdown(markdownString) {
  if (!markdownString) {
    return ''; 
  }

  // marked.parse() is synchronous and returns a pure HTML string.
  return marked.parse(markdownString); 
}