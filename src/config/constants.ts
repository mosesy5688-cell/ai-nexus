/**
 * Frontend Constants
 * V6.0 Configuration values for the frontend
 */

// R2 Cache Base URL - used to fetch precomputed JSON files
export const R2_CACHE_URL = 'https://cdn.free2aitools.com';

// Alternative: Use relative path if served from same domain
export const CACHE_PREFIX = '/cache';

// Category slugs (must match Annex A.2.1)
export const CATEGORY_SLUGS = [
    'text-generation',
    'knowledge-retrieval',
    'vision-multimedia',
    'automation-workflow',
    'infrastructure-ops'
] as const;

export type CategorySlug = typeof CATEGORY_SLUGS[number];
