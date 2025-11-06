// src/lib/data.ts
import { resolve } from 'path';
import fs from 'fs';

/**
 * Defines the structure for a tool object, mirroring the data in models.json.
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

// --- Synchronous, Robust File Loading (Bypassing Rollup/Vite Module Resolution) ---

// FIX: Resolve the absolute path to models.json relative to the project's root (process.cwd()).
// The file is assumed to be moved to the public/ directory, which Astro copies to the build root.
const DATA_FILE_PATH = resolve(process.cwd(), 'public/models.json');

// 3. Synchronously read and parse the JSON file during module initialization
let ALL_TOOLS: Tool[] = [];
try {
  // Read the file content as a string
  const fileContent = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
  // Parse the JSON content
  const toolsData = JSON.parse(fileContent);
  // Cast and assign
  ALL_TOOLS = toolsData as Tool[];
} catch (e) {
  // If the file is missing (e.g., during development setup), we log an error
  // but allow the application to proceed with empty data, preventing a build crash.
  console.error(`ERROR: Failed to load tool data from ${DATA_FILE_PATH}`);
  console.error('This is usually because the data generation script was not run, or the path is incorrect.');
  console.error(e);
}

// ----------------------------------------------------------------------------------

/**
 * Returns all available tools from the static models.json file.
 *
 * @returns An array of Tool objects.
 */
export function getAllTools(): Tool[] {
  // Returning a copy of the pre-imported ALL_TOOLS array is synchronous and fast.
  return [...ALL_TOOLS];
}

/**
 * Filters the complete list of tools based on a given keyword slug.
 * The slug is matched against the tags and task fields of each tool.
 *
 * @param slug The keyword slug to filter by (e.g., 'ai-image-generation').
 * @returns An array of Tool objects that match the keyword.
 */
export function getToolsForKeyword(slug: string): Tool[] {
  const allTools = getAllTools();

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
