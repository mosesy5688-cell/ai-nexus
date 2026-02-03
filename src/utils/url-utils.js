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
 */
export function generateUrlSlug(entity) {
    if (!entity) return '';
    const id = entity.id || entity.umid || entity.slug || '';
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

    // Use the robust core router
    return getRouteFromId(id, entityType);
}

/**
 * Parse URL path to extract entity type and slug
 */
export function parseEntityUrl(pathname) {
    if (!pathname || pathname === '/') return { type: 'model', slug: '' };

    // Handle listing roots (/model, /agent, etc.)
    const rootMatch = pathname.match(/^\/(model|dataset|paper|agent|benchmark|tool|space)\/?$/);
    if (rootMatch) {
        return { type: rootMatch[1], slug: '' };
    }

    const match = pathname.match(/^\/(model|dataset|paper|agent|benchmark|tool|space)\/(.+)$/);
    if (match) {
        return { type: match[1], slug: match[2] };
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

    // V16.7.1: Robust Prefix & Aesthetic Redirection
    // We split by / and check if any segment NEEDS cleaning (contains -- or prefix)
    const segments = cleanPath.split('/').filter(Boolean);
    let needsRedirect = false;
    const cleanedSegments = segments.map((seg, index) => {
        const stripped = stripPrefix(seg);
        if (stripped !== seg.toLowerCase() && !seg.includes('--')) {
            needsRedirect = true;
            return stripped.replace(/--/g, '/');
        }
        // V16.9.22: Only redirect legacy author--name format if it's NOT the root type segment
        // V16.9.22: Use centralized stripPrefix for consistency
        // V16.9.22: Less aggressive with double-dashes to avoid mangling new IDs
        if (seg.includes('--') && index > 0 && !seg.includes('-model-') && !seg.includes('-dataset-')) {
            needsRedirect = true;
            return stripped.replace(/--/g, '/'); // Apply stripPrefix before replacing --
        }
        return seg;
    });

    if (needsRedirect) {
        return '/' + cleanedSegments.join('/');
    }

    return null;
}
