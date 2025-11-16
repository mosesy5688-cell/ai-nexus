// File: src/components/markdown.js 

import { createMarkdownProcessor } from '@astrojs/markdown-remark'; 

/**
 * Compiles a raw Markdown string into its final HTML output.
 * @param {string} markdownString - The raw Markdown content to compile.
 * @returns {Promise<string>} The compiled HTML string.
 */
export async function renderMarkdown(markdownString) {
  if (!markdownString) {
    return ''; 
  }

  // 1. Create the processor
  const processor = await createMarkdownProcessor({});
  
  // 2. Render the markdown
  const result = await processor.render(markdownString);

  // 3. CRITICAL: Return ONLY the raw HTML string, not the whole result object
  return result.html || ''; 
}