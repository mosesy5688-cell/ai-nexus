// File: src/components/markdown.js

// FIX: Change the import path to the stable, supported utility for raw Markdown rendering.
import { compile } from '@astrojs/markdown-remark'; 

/**
 * Compiles a raw Markdown string into a renderable Astro component factory.
 * This is used for dynamically loaded README content.
 * @param {string} markdownString - The raw Markdown content to compile.
 * @returns {Promise<{ Content: import('astro').AstroComponentFactory }>}
 */
export async function renderMarkdown(markdownString) {
  if (!markdownString) {
    return { Content: () => null }; 
  }

  // Use the correct compile function
  const result = await compile({
    content: markdownString,
  });

  // The compile function returns the result object { Content, ... }
  return result; 
}