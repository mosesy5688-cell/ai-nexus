import type { AstroGlobal } from 'astro';
import localModels from '../../public/models.json';

interface Model {
  id: string;
  name: string;
  author?: string;
  sourcePlatform?: 'Hugging Face' | 'Civitai';
  source: string;
  description?: string;
  task: string;
  tags: string[];
  likes: number;
  downloads: number;
  lastModified: string;
}

interface Tool {
  name: string;
  free: string;
  limit: string;
  source: string;
  description: string;
}

/**
 * Fetches model data.
 * In a production Cloudflare environment, it fetches from KV.
 * In all other environments (build, dev), it falls back to the local JSON file.
 */
export async function getModels(): Promise<Model[]> {
  // In a pure static build (`output: 'static'`), we only ever read from the local file.
  // The `npm run discover` script ensures this file has the latest data before the build starts.
  // This completely eliminates any dependency on runtime environments during the build process.
  return localModels as Model[];
}

/**
 * Dynamically fetches tool data for a given keyword from static JSON files.
 */
export async function getToolsForKeyword(keyword: string): Promise<Tool[]> {
  try {
    // Dynamically import the JSON file based on the keyword slug.
    // This makes the function scalable for new tool categories.
    const toolModule = await import(`../content/auto/${keyword}.json`);
    return toolModule.data || [];
  } catch (error) {
    // If the file doesn't exist for a given keyword, return an empty array.
    console.warn(`[data] No tool data found for keyword: ${keyword}`);
    return [];
  }
}