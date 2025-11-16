// NOTE: This implementation is required for the fix in [...slug].astro to work.
// It assumes the project is using the @astrojs/mdx integration.
import { compile } from '@astrojs/mdx';

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

  const result = await compile(markdownString);
  return result;
}
