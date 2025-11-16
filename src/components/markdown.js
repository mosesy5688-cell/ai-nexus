// NOTE: This implementation is required for the fix in [...slug].astro to work.
// It assumes the project is using the @astrojs/mdx integration.
// FIX: Changed import path from '@astrojs/mdx' to the correct internal utility path.
import { compile } from '@astrojs/mdx/server'; 

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

  // Use the Astro/MDX compile function to convert the string to a component.
  const result = await compile({
    content: markdownString,
    // The scope or path for the content source is sometimes needed, 
    // but the content itself is passed directly.
  });

  // The compile function directly returns the result object we need.
  return result; 
}