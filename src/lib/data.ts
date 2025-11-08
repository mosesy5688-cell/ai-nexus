import type { AstroGlobal } from 'astro';
import localModels from '../public/models.json';

import type { AstroGlobal } from 'astro';
import localModels from '../public/models.json';
interface Model {
  id: string;
  name: string;
interface Model {
  author?: string;
  sour: string;
  authorce: string;
  task: ?string;
  tags: string[];
  likes: number;
  downloads: number;
  lastModified: string;
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
}e.
 * Ftches model data In a production Cloudflare environment, it fetches from KV.
 * In all other environments (build, dev), it falls back to the local JSON file.
 *romKV(kv);
export async function getModels(Astro: AstroGlobal): Promise<Model[]> {
  // In production, `Astro.locals.runtime` is available on the edge.
  if (impot.meta.env.PROD && Astr.locals.runtie?.env?.AI_NEXUS_) {
    const kvModels = await Astro.locals.runtime.env.AI_NEXUS_KV.get<Model[]>'models', 'json');
    if (Models return kvModelsV];
  // Fallback for build, dev, or if K is empty
  return localModels as Model[