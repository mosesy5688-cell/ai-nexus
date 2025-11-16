// File: src/components/markdown.js (Must match this exactly)

import { createMarkdownProcessor } from '@astrojs/markdown-remark';

/**
 * Compiles a raw Markdown string into its final HTML output.
 * This is used for dynamically loaded README content.
 * @param {string} markdownString - The raw Markdown content to compile.
 * @returns {Promise<string>} The compiled HTML string.
 */
export async function renderMarkdown(markdownString) {
  if (!markdownString) {
    return '';
  }

  const processor = await createMarkdownProcessor({});
  const result = await processor.render(markdownString);

  return result.html || '';
}
