import type { AstroGlobal } from 'astro';
import localModels from '../../public/models.json';
import logoTools from '../content/auto/logo.json';

interface Model {
  id: string;
  name: string;
  author?: string;
  source: string;
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
export async function getModels(Astro: AstroGlobal): Promise<Model[]> {
  // In production, `Astro.locals.runtime` is available on the edge.
  if (import.meta.env.PROD && Astro.locals.runtime?.env?.AI_NEXUS_KV) {
    const kvModels = await Astro.locals.runtime.env.AI_NEXUS_KV.get<Model[]>('models', 'json');
    if (kvModels) return kvModels;
  }
  // Fallback for build, dev, or if KV is empty
  return localModels as Model[];
}

/**
 * Fetches tool data for a given keyword from static JSON files.
 * This is a simplified implementation. A more robust solution would
 * dynamically import based on the keyword.
 */
export function getToolsForKeyword(keyword: string): Tool[] {
  // Currently, we only have 'logo' tools data.
  if (keyword === 'logo-design') { // Assuming 'logo-design' is the slug
    return logoTools.data;
  }
  return [];
}