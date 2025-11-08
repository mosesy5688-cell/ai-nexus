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
  // import.meta.env.SSR is true during the build process (prerendering) AND
  // when server-rendering on the edge. We need to distinguish between them.
  if (import.meta.env.SSR) {
    // Astro.locals.runtime is ONLY available on the edge, NOT during the build.
    if (Astro.locals.runtime?.env?.AI_NEXUS_KV) {
      const kvModels = await Astro.locals.runtime.env.AI_NEXUS_KV.get<Model[]>('models', 'json');
      // If KV has data, return it. Otherwise, fall through to the local file.
      if (kvModels) return kvModels;
    }
    // During the build (`npm run build`), runtime is undefined, so we ALWAYS fall back here.
    // This is the key to fixing the build error permanently.
    return localModels as Model[];
  }
  // This will be used for client-side rendering, if any, or as a final fallback.
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