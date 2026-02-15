/**
 * URL Utilities V1.0 - Universal Entity URL Generation
 * 
 * CES Compliant: Internal IDs preserve source prefix, URLs are clean
 * Art 9.1: No internal structure exposed in public URLs
 * 
 * @module url-utils
 */

import { getRouteFromId, stripPrefix, getTypeFromId } from './mesh-routing-core.js';

/**
 * Entity type to URL prefix mapping (Reference only, preferred use getRouteFromId)
 */
const ENTITY_URL_PREFIXES = {
    model: '/model/',
    dataset: '/dataset/',
    paper: '/paper/',
    agent: '/agent/',
    benchmark: '/benchmark/',
    tool: '/tool/',
};

/**
 * Generate URL-safe slug from entity (Centralized V2.0)
 * V2.0 Decision: Slug IS the Full Canonical ID for primary types.
 */
export function generateUrlSlug(entity) {
    if (!entity) return '';
    const id = entity.id || entity.umid || entity.slug || '';
    // V2.1 Standard: Hierarchical SEO Slug (strip prefixes and convert -- to /)
    return stripPrefix(id).replace(/--/g, '/');
}

/**
 * Generate full entity URL
 * V16.7.1: Now redirects to centralized mesh-routing-core logic
 */
export function generateEntityUrl(entity, type) {
    if (!entity) return '/';
    const id = entity.id || entity.umid || entity.slug || '';
    const entityType = type || entity.type || entity.entity_type || getTypeFromId(id);

    return getRouteFromId(id, entityType);
}

/**
 * Parse URL path to extract entity type and slug
 */
export function parseEntityUrl(pathname) {
    if (!pathname || pathname === '/') return { type: 'model', slug: '' };

    // Handle listing roots (/model, /models, /agent, /agents, etc.)
    const rootMatch = pathname.match(/^\/(model|models|dataset|datasets|paper|papers|agent|agents|benchmark|benchmarks|tool|tools|space|spaces)\/?$/);
    if (rootMatch) {
        // Normalize back to singular for internal type consistency if needed, 
        // but for listing roots we mostly care about the type.
        const type = rootMatch[1].replace(/s$/, '');
        return { type: type === 'benchmark' ? 'tool' : type, slug: '' };
    }

    const match = pathname.match(/^\/(model|models|dataset|datasets|paper|papers|agent|agents|benchmark|benchmarks|tool|tools|space|spaces)\/(.+)$/);
    if (match) {
        const type = match[1].replace(/s$/, '');
        return { type: type === 'benchmark' ? 'tool' : type, slug: match[2] };
    }

    // Fallback: treat as model if no other match
    const segments = pathname.split('/').filter(Boolean);
    return { type: 'model', slug: segments[segments.length - 1] || '' };
}

/**
 * Convert URL slug back to internal lookup format
 * Used by cache reader to find entities
 * 
 * @param {string} urlSlug - URL slug (e.g., "meta-llama/llama-3")
 * @param {string} [source] - Optional source hint (e.g., "huggingface")
 * @returns {string[]} Array of possible internal ID formats to try
 * 
 * @example
 * urlSlugToLookupFormats('meta-llama/llama-3')
 * // Returns: ['meta-llama/llama-3', 'huggingface:meta-llama/llama-3', ...]
 */
export function urlSlugToLookupFormats(urlSlug, source) {
    if (!urlSlug) return [];

    const normalized = urlSlug.toLowerCase();
    const formats = [normalized];

    // Common source prefixes to try
    const sources = source ? [source] : ['huggingface', 'github', 'arxiv', 'ollama', 'replicate'];

    for (const src of sources) {
        formats.push(`${src}:${normalized}`);
    }

    return formats;
}

/**
 * Check if a URL needs redirect (contains encoded characters or old format)
 * 
 * @param {string} pathname - URL pathname
 * @returns {string|null} New pathname if redirect needed, null otherwise
 */
export function getRedirectPath(pathname) {
    if (!pathname || pathname === '/') return null;

    // Remove trailing slash for normalization
    const cleanPath = pathname.replace(/\/$/, '');

    // V16.7.2: Canonical Route Validation
    // Parse the URL to identify type and slug
    const { type, slug } = parseEntityUrl(cleanPath);
    if (!slug) return null;

    // Generate canonical URL using established SSOT routes
    // This handles stripPrefix and dual-dash replacement automatically
    const canonical = getRouteFromId(slug, type);

    // If canonical differs and is valid, suggest redirect
    if (canonical && canonical !== '#' && canonical !== cleanPath) {
        // Multi-segment validation: Ensure we don't redirect to something that would loop
        // (canonical already uses established prefixes and routes)
        return canonical;
    }

    return null;
}

