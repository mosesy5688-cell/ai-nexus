/**
 * URL Utilities V1.0 - Universal Entity URL Generation
 * 
 * CES Compliant: Internal IDs preserve source prefix, URLs are clean
 * Art 9.1: No internal structure exposed in public URLs
 * 
 * @module url-utils
 */

/**
 * Entity type to URL prefix mapping
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
 * Generate URL-safe slug from entity (URL-ROUTING-SPEC-V1.0)
 * Priority: entity.id > entity.slug > author/name
 * 
 * @param {Object} entity - Entity with id, slug, source, type, author, name fields
 * @returns {string} URL path segment (without prefix) in format: owner/name
 * 
 * @example
 * generateUrlSlug({ id: 'huggingface:meta-llama/Llama-3' })
 * // Returns: 'meta-llama/llama-3'
 */
export function generateUrlSlug(entity) {
    if (!entity) return '';

    // V9.0 URL-ROUTING-SPEC-V1.0: Priority 1 - Extract from entity.id
    // HuggingFace format can be:
    // - "huggingface:meta-llama/Llama-3" (slash-separated)
    // - "huggingface:meta-llama:Llama-3" (colon-separated - from L8)
    // - "huggingface:hexgrad:kokoro-82m" (colon-separated - from trending.json)
    const id = entity.id || entity.umid || '';
    if (id) {
        // Remove source prefix (huggingface:, arxiv:, github:, hf:)
        let cleanId = id.replace(/^[a-z]+:/i, '');

        // V15.0 FIX: Strictly strip known entity prefixes (hf-dataset/, spaces/)
        // This prevents URLs like /dataset/hf-dataset/author/name
        cleanId = cleanId.replace(/^hf-dataset\//i, '')
            .replace(/^spaces\//i, '')
            .replace(/^datasets\//i, '')
            .replace(/^models\//i, '');

        // V14.4 Fix: Handle multiple colons (author:name format from trending.json)
        // Example: "hexgrad:kokoro-82m" -> "hexgrad/kokoro-82m"
        if (cleanId.includes(':') && !cleanId.includes('/')) {
            // Replace first colon with slash (author:name -> author/name)
            cleanId = cleanId.replace(':', '/');
        }

        // If contains slash, it's owner/name format - use it directly
        if (cleanId.includes('/')) {
            return cleanId.toLowerCase().trim().replace(/_/g, '-');
        }

        // V14.4: If no slash but has content, try to use it as slug directly
        if (cleanId && cleanId.length > 0) {
            return cleanId.toLowerCase().trim().replace(/_/g, '-');
        }
    }

    // Priority 2 - Use pre-computed slug (L8 format: huggingface--owner--name)
    let slug = entity.slug || '';
    if (slug && slug.includes('--')) {
        const parts = slug.split('--');
        if (parts.length >= 3) {
            // Format: source--owner--name, take last two parts
            const owner = parts[parts.length - 2];
            const name = parts[parts.length - 1];
            return `${owner}/${name}`.toLowerCase().trim();
        } else if (parts.length === 2) {
            return `${parts[0]}/${parts[1]}`.toLowerCase().trim();
        }
    }

    // Priority 3 - Fallback to author/name (may be display name, less reliable)
    const author = entity.author || entity.organization || '';
    const name = entity.name || entity.canonical_name || '';
    if (author && name) {
        return `${author}/${name}`.toLowerCase().trim().replace(/_/g, '-');
    }

    // Last resort: use whatever slug/id we have
    slug = slug || id || '';
    slug = slug.replace(/^[a-z]+:/i, '').toLowerCase().trim();
    return slug;
}

/**
 * Generate full entity URL
 * 
 * @param {Object} entity - Entity object
 * @param {string} [type] - Optional type override (model, dataset, paper, etc.)
 * @returns {string} Full URL path
 * 
 * @example
 * generateEntityUrl({ id: 'huggingface:meta-llama/Llama-3', type: 'model' })
 * // Returns: '/model/meta-llama/llama-3'
 */
export function generateEntityUrl(entity, type) {
    if (!entity) return '/';

    const entityType = type || entity.type || entity.entity_type || 'model';
    const prefix = ENTITY_URL_PREFIXES[entityType] || '/model/';
    const slug = generateUrlSlug(entity);

    return `${prefix}${slug}`;
}

/**
 * Parse URL path to extract entity type and slug
 * 
 * @param {string} pathname - URL pathname (e.g., "/model/meta-llama/llama-3")
 * @returns {{type: string, slug: string}}
 * 
 * @example
 * parseEntityUrl('/model/meta-llama/llama-3')
 * // Returns: { type: 'model', slug: 'meta-llama/llama-3' }
 */
export function parseEntityUrl(pathname) {
    if (!pathname) return { type: 'model', slug: '' };

    const match = pathname.match(/^\/(model|dataset|paper|agent|benchmark|tool)\/(.+)$/);
    if (match) {
        return { type: match[1], slug: match[2] };
    }

    // Fallback: treat as model
    return { type: 'model', slug: pathname.replace(/^\//, '') };
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
    if (!pathname) return null;

    // Check for URL-encoded colons (%3A)
    if (pathname.includes('%3A') || pathname.includes('%3a')) {
        const decoded = decodeURIComponent(pathname);
        // Remove source prefix from entity URLs
        const cleaned = decoded.replace(
            /^(\/(model|dataset|paper|agent|benchmark))\/[a-z]+:/i,
            '$1/'
        );
        if (cleaned !== pathname) {
            return cleaned.toLowerCase();
        }
    }

    // Check for double-dash format (old format: meta-llama--Llama-3)
    if (pathname.includes('--')) {
        const cleaned = pathname.replace(/--/g, '/');
        if (cleaned !== pathname) {
            return cleaned.toLowerCase();
        }
    }

    return null;
}
