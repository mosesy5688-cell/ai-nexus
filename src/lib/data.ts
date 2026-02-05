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
 * DEPRECATED: Use fetchCatalogData instead.
 * Preserved for type safety in legacy modules.
 */
export async function getModels(): Promise<Model[]> {
  return [];
}

/**
 * DEPRECATED: Use shingles/knowledge fetchers instead.
 */
export async function getToolsForKeyword(keyword: string): Promise<Tool[]> {
  return [];
}