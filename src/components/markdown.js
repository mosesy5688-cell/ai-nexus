// File: src/components/markdown.js

import { createMarkdownProcessor } from '@astrojs/markdown-remark'; 

/**
 * Compiles a raw Markdown string into its final HTML output.
 * @param {string} markdownString - The raw Markdown content to compile.
 * @returns {Promise<string>} The compiled HTML string.
 */
export async function renderMarkdown(markdownString) {
  if (!markdownString) {
    return ''; // Return an empty string
  }

  const processor = await createMarkdownProcessor({});
  
  // Use the processor to render the Markdown content
  const result = await processor.render(markdownString);

  // FIX: Return the HTML string directly, not the component factory object.
  return result.html || ''; 
}