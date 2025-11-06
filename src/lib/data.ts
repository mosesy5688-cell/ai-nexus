import { resolve } from 'path';
import fs from 'fs';
import type { KVNamespace } from '@cloudflare/workers-types';

// Define the structure for a tool object
export interface Tool {
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

// Function to get tools from Cloudflare KV
async function getToolsFromKV(kv: KVNamespace): Promise<Tool[]> {
  const data = await kv.get("models", "json");
  return data || [];
}

// --- Synchronous, Robust File Loading for Development ---
const DATA_FILE_PATH = resolve(process.cwd(), 'public/models.json');
let ALL_TOOLS_DEV: Tool[] = [];
try {
  const fileContent = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
  ALL_TOOLS_DEV = JSON.parse(fileContent) as Tool[];
} catch (e) {
  console.error(`ERROR: Failed to load tool data from ${DATA_FILE_PATH}`);
}

/**
 * Returns all available tools.
 * In a production environment, it fetches from Cloudflare KV.
 * In a development environment, it reads from the local models.json file.
 */
export async function getAllTools(kv?: KVNamespace): Promise<Tool[]> {
  if (import.meta.env.PROD && kv) {
    return await getToolsFromKV(kv);
  }
  return [...ALL_TOOLS_DEV];
}

/**
 * Filters the complete list of tools based on a given keyword.
 */
export async function getToolsForKeyword(keyword: string, kv?: KVNamespace): Promise<Tool[]> {
  const allTools = await getAllTools(kv);
  const normalizedKeyword = keyword.toLowerCase().replace(/-/g, ' ');

  return allTools.filter(tool => {
    const matchesTag = tool.tags?.some(tag =>
      tag.toLowerCase().includes(normalizedKeyword)
    );
    const matchesTask = tool.task?.toLowerCase().includes(normalizedKeyword);
    return matchesTag || matchesTask;
  });
}

