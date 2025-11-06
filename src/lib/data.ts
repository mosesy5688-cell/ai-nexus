// src/lib/data.ts

/**
 * Defines the structure for a tool object, mirroring the data in models.json.
 * These properties match the data saved by scripts/fetch-data.js.
 */
interface Tool {
  id: string;
  name: string;
  author: string;
  source: string;
  task: string;
  tags: string[];
  likes: number;
  downloads: number;
  lastModified: string;
}

// FIX: Revert to relative path to ensure stable import of the static JSON file.
import toolsData from '../data/models.json';

// Cast the imported data to the Tool array type.
const ALL_TOOLS: Tool[] = toolsData as Tool[];


/**
 * Returns all available tools from the static models.json file.
 *
 * @returns A promise that resolves to an array of `Tool` objects.
 */
export async function getAllTools(): Promise<Tool[]> {
  // Returning a copy of the pre-imported ALL_TOOLS array is synchronous and fast.
  return [...ALL_TOOLS];
}

/**
 * Filters the complete list of tools based on a given keyword slug.
 * The slug is matched against the `tags` and `task` fields of each tool.
 *
 * @param slug The keyword slug to filter by (e.g., 'ai-image-generation').
 * @returns A promise that resolves to an array of `Tool` objects that match the keyword.
 */
export async function getToolsForKeyword(slug: string): Promise<Tool[]> {
  const allTools = await getAllTools();

  // Normalize the input slug for case-insensitive and hyphen-agnostic matching.
  const normalizedSlug = slug.toLowerCase().replace(/-/g, ' ');

  // Filter the tools
  return allTools.filter(tool => {
    // 1. Check if tags match
    const matchesTag = tool.tags?.some(tag =>
      tag.toLowerCase().includes(normalizedSlug)
    );

    // 2. Check if the primary task matches
    const matchesTask = tool.task?.toLowerCase().includes(normalizedSlug);

    // A tool matches if its tags OR its task includes the normalized slug.
    return matchesTag || matchesTask;
  });
}
