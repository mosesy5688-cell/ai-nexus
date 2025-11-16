// File: src/components/markdown.js (Must match this exactly)

import { createMarkdownProcessor } from '@astrojs/markdown-remark'; 

/**
 * Compiles a raw Markdown string into its final HTML output.
 * @param {string} markdownString - The raw Markdown content to compile.
 * @returns {Promise<string>} The compiled HTML string.
 */
export async function renderMarkdown(markdownString) { // Exported name is 'renderMarkdown'
  if (!markdownString) {
    return ''; 
  }

  // Use createMarkdownProcessor for the official and stable way to render
  const processor = await createMarkdownProcessor({});
  
  const result = await processor.render(markdownString);

  // Return the raw HTML string
  return result.html || ''; 
}