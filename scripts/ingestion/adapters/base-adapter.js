/**
 * Base Adapter Class
 * 
 * Abstract base class for all data source adapters.
 * Each adapter must implement the abstract methods to normalize
 * source-specific data into the Universal Entity Schema.
 * 
 * @module ingestion/adapters/base-adapter
 */

import crypto from 'crypto';
import { normalizeId } from '../../utils/id-normalizer.js';

/**
 * Unified Entity Schema - All adapters must output this format
 * @typedef {Object} UnifiedEntity
 * @property {string} id - Unique ID: {source}:{author}:{name}
 * @property {string} type - Entity type: model/paper/dataset/tool/space
 * @property {string} source - Source platform
 * @property {string} source_url - Original URL
 * @property {string} title - Display title
 * @property {string} description - Short description (max 500 chars)
 * @property {string} body_content - Full README/content (max 100KB)
 * @property {string[]} tags - Normalized tags
 * @property {string} author - Author/organization
 * @property {string} license_spdx - SPDX license ID
 * @property {Object} meta_json - Extended metadata
 * @property {number} popularity - Normalized popularity score
 * @property {string} raw_image_url - Image URL for processing
 * @property {Object[]} relations - Discovered relationships
 * @property {string} content_hash - Content fingerprint
 * @property {string} compliance_status - approved/pending/flagged/blocked
 * @property {number} quality_score - 0-100 quality rating
 */

/**
 * NSFW Keywords for compliance checking
 */
export const NSFW_KEYWORDS = [
    // Original 10
    'nsfw', 'porn', 'sexy', 'explicit', 'erotic',
    'nude', 'naked', 'adult', 'xxx', 'hentai',
    // Extended 15
    'lewd', 'provocative', '18+', 'mature', 'uncensored',
    'r18', 'r-18', 'gore', 'violence', 'fetish',
    'lolicon', 'shotacon', 'ecchi', 'ahegao', 'harem'
];

/**
 * SPDX License Mapping
 */
export const LICENSE_MAP = {
    // Open Source
    'apache-2.0': 'Apache-2.0',
    'apache 2.0': 'Apache-2.0',
    'mit': 'MIT',
    'gpl-3.0': 'GPL-3.0',
    'gpl-2.0': 'GPL-2.0',
    'bsd-3-clause': 'BSD-3-Clause',
    'bsd-2-clause': 'BSD-2-Clause',
    // Model-specific
    'llama3': 'LLaMA-3',
    'llama-3': 'LLaMA-3',
    'llama2': 'LLaMA-2',
    'llama-2': 'LLaMA-2',
    'gemma': 'Gemma',
    'openrail': 'OpenRAIL',
    'openrail++': 'OpenRAIL++',
    'bigscience-openrail-m': 'BigScience-OpenRAIL-M',
    // Creative Commons
    'cc-by-4.0': 'CC-BY-4.0',
    'cc-by-sa-4.0': 'CC-BY-SA-4.0',
    'cc-by-nc-4.0': 'CC-BY-NC-4.0',
    'cc-by-nc-sa-4.0': 'CC-BY-NC-SA-4.0',
    'cc0-1.0': 'CC0-1.0',
    // Other
    'unlicense': 'Unlicense',
    'wtfpl': 'WTFPL',
    'other': 'Other'
};

/**
 * Base Adapter - Abstract class for all source adapters
 */
export class BaseAdapter {
    /**
     * @param {string} sourceName - Unique source identifier (e.g., 'huggingface')
     */
    constructor(sourceName) {
        if (this.constructor === BaseAdapter) {
            throw new Error('BaseAdapter is abstract and cannot be instantiated directly');
        }
        this.sourceName = sourceName;
        this.entityTypes = ['model']; // Override in subclass
    }

    // ============================================================
    // Abstract Methods - Must be implemented by subclasses
    // ============================================================

    /**
     * Fetch raw entities from the source
     * @abstract
     * @param {Object} options - Fetch options (limit, filters, etc.)
     * @returns {Promise<Object[]>} Raw entities from source
     */
    async fetch(options = {}) {
        throw new Error('fetch() must be implemented by subclass');
    }

    /**
     * [Phase A.2] Streaming fetch for memory-efficient batch processing
     * Yields batches of entities instead of loading all into memory.
     * 
     * Default implementation calls fetch() and yields in batches.
     * Subclasses can override for true pagination support.
     * 
     * @param {Object} options - Fetch options
     * @param {number} [options.batchSize=500] - Entities per batch
     * @param {number} [options.limit=10000] - Max total entities
     * @yields {Object[]} Batch of raw entities
     */
    async *fetchStream(options = {}) {
        const { batchSize = 500, limit = 10000 } = options;

        // Default: fetch all then yield in batches
        // Subclasses should override for true pagination
        const allEntities = await this.fetch({ ...options, limit });

        for (let i = 0; i < allEntities.length; i += batchSize) {
            const batch = allEntities.slice(i, i + batchSize);
            console.log(`  [Stream] Yielding batch ${Math.floor(i / batchSize) + 1}: ${batch.length} entities`);
            yield batch;

            // Allow GC between batches
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    /**
     * Normalize a raw entity to UnifiedEntity format
     * @abstract
     * @param {Object} raw - Raw entity from source
     * @returns {UnifiedEntity} Normalized entity
     */
    normalize(raw) {
        throw new Error('normalize() must be implemented by subclass');
    }

    /**
     * Extract meaningful assets (images) from raw entity
     * @abstract
     * @param {Object} raw - Raw entity from source
     * @returns {Object[]} Array of {type, url} objects
     */
    extractAssets(raw) {
        throw new Error('extractAssets() must be implemented by subclass');
    }

    // ============================================================
    // Common Utility Methods
    // ============================================================

    /**
     * Generate unique ID in format: {source}-{type}--{author}--{name}
     * V16.96: Implementation of Universal Prefixing Standard V2.0
     */
    generateId(author, name, type = null) {
        const resolvedType = type || (this.entityTypes.length === 1 ? this.entityTypes[0] : 'model');
        const rawId = `${author}/${name}`;

        // Centralized normalization (V2.0 Standard)
        return normalizeId(rawId, this.sourceName, resolvedType);
    }

    /**
     * Sanitize name for ID generation
     */
    sanitizeName(name) {
        return (name || 'unknown')
            .toLowerCase()
            .replace(/[\/\\]/g, '-')
            .replace(/[^a-z0-9-_.]/g, '')
            .substring(0, 100);
    }

    /**
     * Delay helper for rate limiting
     * @param {number} ms - Milliseconds to wait
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Normalize license to SPDX ID
     * V4.1: Handle object-type licenses (e.g., {name: 'apache-2.0'})
     */
    normalizeLicense(rawLicense) {
        if (!rawLicense) return null;

        // Handle object-type licenses (HuggingFace sometimes returns objects)
        let licenseStr;
        if (typeof rawLicense === 'string') {
            licenseStr = rawLicense;
        } else if (typeof rawLicense === 'object' && rawLicense !== null) {
            // Handle {name: "license"} or {id: "license"} or {spdx_id: "license"}
            licenseStr = rawLicense.name || rawLicense.id || rawLicense.spdx_id ||
                (rawLicense.license ? String(rawLicense.license) : null);
            if (!licenseStr) {
                // Last resort: stringify the object
                try {
                    licenseStr = JSON.stringify(rawLicense);
                } catch {
                    return 'Unknown';
                }
            }
        } else {
            return 'Unknown';
        }

        const key = licenseStr.toLowerCase().trim();
        return LICENSE_MAP[key] || licenseStr;
    }

    /**
     * Check if content contains NSFW keywords
     */
    checkNSFW(entity) {
        const textToCheck = [
            entity.title || '',
            entity.description || '',
            ...(entity.tags || [])
        ].join(' ').toLowerCase();

        for (const keyword of NSFW_KEYWORDS) {
            if (textToCheck.includes(keyword)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Determine compliance status
     */
    getComplianceStatus(entity) {
        if (this.checkNSFW(entity)) {
            return 'blocked';
        }
        if (!entity.license_spdx) {
            return 'pending';
        }
        return 'approved';
    }

    /**
     * Generate content hash for change detection
     */
    generateContentHash(entity) {
        const content = JSON.stringify({
            title: entity.title,
            description: entity.description,
            tags: entity.tags,
            body_content: entity.body_content?.substring(0, 1000) // First 1KB
        });
        return crypto.createHash('md5').update(content).digest('hex');
    }

    /**
     * Calculate quality score (0-100)
     */
    calculateQualityScore(entity) {
        let score = 0;

        // Content completeness (40 points)
        const contentLength = entity.body_content?.length || 0;
        if (contentLength > 500) score += 10;
        if (contentLength > 2000) score += 15;
        if (contentLength > 10000) score += 15;

        // Asset quality (30 points)
        if (entity.raw_image_url) score += 20;
        if (entity.license_spdx) score += 10;

        // Popularity (30 points)
        const popularity = entity.popularity || 0;
        score += Math.min(30, Math.log10(popularity + 1) * 10);

        return Math.round(score * 10) / 10;
    }

    /**
     * Truncate text to max length
     */
    truncate(text, maxLength) {
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    }

    /**
     * Extract description from body content
     */
    extractDescription(bodyContent, maxLength = 500) {
        if (!bodyContent) return '';

        // Remove markdown headers
        let text = bodyContent.replace(/^#+\s+.*$/gm, '');
        // Remove code blocks
        text = text.replace(/```[\s\S]*?```/g, '');
        // Remove inline code
        text = text.replace(/`[^`]+`/g, '');
        // Remove links
        text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        // Remove images
        text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');
        // Remove extra whitespace
        text = text.replace(/\s+/g, ' ').trim();

        return this.truncate(text, maxLength);
    }

    /**
     * Extract GitHub URLs from content
     */
    extractGitHubUrls(content) {
        if (!content) return [];
        const regex = /https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s\)]+)/g;
        const urls = [];
        let match;
        while ((match = regex.exec(content)) !== null) {
            urls.push({
                url: match[0],
                owner: match[1],
                repo: match[2].replace(/[#?].*$/, '')
            });
        }
        return urls;
    }

    /**
     * Extract ArXiv IDs from tags
     */
    extractArxivIds(tags) {
        if (!Array.isArray(tags)) return [];
        return tags
            .filter(t => typeof t === 'string' && t.startsWith('arxiv:'))
            .map(t => t.replace('arxiv:', ''));
    }

    /**
     * Discover relationships from entity
     */
    discoverRelations(entity) {
        const relations = [];

        // GitHub code repositories
        const githubUrls = this.extractGitHubUrls(entity.body_content);
        for (const gh of githubUrls) {
            relations.push({
                type: 'has_code',
                target_id: `github:${gh.owner}:${gh.repo}`,
                source_url: gh.url
            });
        }

        // ArXiv papers
        const arxivIds = this.extractArxivIds(entity.tags);
        for (const arxivId of arxivIds) {
            relations.push({
                type: 'based_on_paper',
                target_id: `arxiv:${arxivId}`,
                source_url: `https://arxiv.org/abs/${arxivId}`
            });
        }

        return relations;
    }

    /**
     * Generate source trail for audit
     */
    generateSourceTrail(entity) {
        return [{
            source_platform: this.sourceName,
            source_url: entity.source_url,
            fetched_at: new Date().toISOString(),
            raw_data_hash: this.generateContentHash(entity),
            adapter_version: '3.2.0'
        }];
    }
}

export default BaseAdapter;
