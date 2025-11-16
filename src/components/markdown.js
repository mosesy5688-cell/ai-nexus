// File Path: src/components/markdown.js

// FIX: Import the official public function createMarkdownProcessor
import { createMarkdownProcessor } from '@astrojs/markdown-remark'; 

/**
 * Uses Astro's Markdown engine to compile a raw Markdown string into a renderable Astro component.
 * @param {string} markdownString - The raw Markdown string (i.e., model.readme).
 * @returns {Promise<{ Content: import('astro').AstroComponentFactory }>}
 */
export async function renderMarkdown(markdownString) {
  if (!markdownString) {
    return { Content: () => null }; 
  }

  // 1. Create the Markdown processor. We pass an empty object {} to use default configuration.
  const processor = await createMarkdownProcessor({});

  // 2. Use the processor to render the Markdown string.
  // The .render() method returns the complete result object, including Content (the component).
  const result = await processor.render(markdownString);

  // 3. Return the object containing the Content component, matching the structure expected by your Astro file.
  // If result.Content is missing, we safely return an empty component.
  const Content = result.Content || (() => null);
  
  return { Content }; 
}