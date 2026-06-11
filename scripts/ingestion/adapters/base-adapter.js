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
 * Custom error for non-recoverable rate limits (V22.3)
 */
export class RateLimitExceededError extends Error {
    constructor(source, waitSec) {
        super(`Rate limit for ${source} exceeded threshold: ${waitSec}s wait required.`);
        this.name = 'RateLimitExceededError';
        this.source = source;
        this.waitSec = waitSec;
    }
}

/**
 * Custom error for a source-level fetch/parse failure (H1: fail loud).
 *
 * A caught network/abort/parse error in an adapter MUST NOT launder into a
 * plain empty result that the harvester reports as a green zero-yield run.
 * Throwing this typed error lets the shared chokepoint (harvest-single.js)
 * distinguish an ERROR-caused emptiness (→ fail the source, exit nonzero)
 * from a legitimate zero-record result (HTTP 200, parseable, no new data →
 * stays success). It is intentionally NOT a RateLimitExceededError: rate-limit
 * early-finish is a deliberate CI-throughput tolerance that stays success.
 *
 * @param {string} source - Source identifier (e.g. 'arxiv')
 * @param {('fetch'|'abort'|'parse')} kind - Failure class for the error taxonomy
 * @param {string} detail - Human-readable cause
 */
export class FetchError extends Error {
    constructor(source, kind, detail) {
        super(`Fetch failure for ${source} (${kind}): ${detail}`);
        this.name = 'FetchError';
        this.source = source;
        this.kind = kind;
        this.detail = detail;
    }
}

/**
 * Rate-limit backoff constants (V28: harvest hardening).
 * Used by handleRateLimit() when a 429/403/503 carries NO retry header,
 * so a header-less persistent rate limit escalates and trips a circuit
 * breaker instead of spinning forever at a flat default wait.
 */
const BASE_BACKOFF_MS = 2000;       // First header-less wait (attempt 0)
const MAX_SINGLE_WAIT_MS = 60000;   // Per-call ceiling for header-less backoff
const MAX_429_ATTEMPTS = 6;         // Circuit breaker: give up after this many attempts
const DEFAULT_FETCH_TIMEOUT_MS = 30000; // fetchWithTimeout default abort window

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
     * V22.3: Truly O(1) implementation via internal queue
     * 
     * @param {Object} options - Fetch options
     * @yields {Object[]} Batch of raw entities
     */
    async *fetchStream(options = {}) {
        const { limit = 10000 } = options;
        const queue = [];
        let done = false;
        let error = null;

        // V22.3: True O(1) Memory Producer-Consumer Pattern
        const fetchPromise = this.fetch({
            ...options,
            limit,
            onBatch: async (batch) => {
                if (batch && batch.length > 0) {
                    queue.push(batch);
                }

                // Backpressure: If queue is growing too fast, slow down producer
                if (queue.length > 5) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
        }).then(() => {
            done = true;
        }).catch(err => {
            console.error(`  [Stream] Fetch error: ${err.message}`);
            error = err;
            done = true;
        });

        // Consumer Loop
        while (!done || queue.length > 0) {
            if (queue.length > 0) {
                const batch = queue.shift();
                yield batch;
                // Immediate GC hint
                await new Promise(resolve => setImmediate(resolve));
            } else {
                if (error) throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        await fetchPromise; // Final safety await
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
     * Get default headers for API requests
     * V22.4: Standardized for all adapters
     */
    getHeaders() {
        return {
            'Accept': 'application/json',
            'User-Agent': `Free2AITools-Ingestion/${this.sourceName}`
        };
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
     * V2.1: Check if content is safe for work (NSFW filter)
     * Constitutional: Uses NSFW_KEYWORDS whitelist, no inference
     */
    isSafeForWork(item) {
        const text = `${item.name || item.title || ''} ${item.description || ''}`.toLowerCase();
        return !NSFW_KEYWORDS.some(kw => text.includes(kw));
    }

    /**
     * Delay helper for rate limiting
     * @param {number} ms - Milliseconds to wait
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Handle rate limits (403/429/503) across sources.
     * V22.3: Centralized Industrial Throttling.
     * V28: Header-less escalation + circuit breaker (harvest hardening).
     *
     * When the server provides a `retry-after` / `x-ratelimit-reset` header,
     * its value is honored (capped at the 5-min MAX_WAIT_MS ceiling — a single
     * server-requested wait above that throws RateLimitExceededError).
     *
     * When NO header is present, behavior depends on whether the caller opted
     * into escalation by passing a numeric `attempt`:
     *   - Legacy callers (attempt omitted/undefined) keep the original flat 60s
     *     header-less wait — ZERO behavior change. They maintain their own retry
     *     counters and breakers, so escalating here would silently change them.
     *   - Converted callers (numeric attempt) get exponential escalation
     *     (BASE_BACKOFF_MS * 2**attempt + jitter, capped at MAX_SINGLE_WAIT_MS),
     *     and once `attempt >= MAX_429_ATTEMPTS` the circuit breaker throws
     *     RateLimitExceededError so a header-less persistent limit cannot loop forever.
     *
     * @param {Response} response - Fetch Response object
     * @param {number} [attempt] - Optional. Omit (undefined) for legacy single 60s
     *   header-less wait. Pass a 0-based attempt counter to enable exponential
     *   escalation + circuit breaker (per-source converted callers).
     * @returns {Promise<boolean>} True if waited and the caller should retry, false otherwise
     */
    async handleRateLimit(response, attempt) {
        if (response.status === 403 || response.status === 429 || response.status === 503) {
            // Check for GitHub secondary rate limit (403 with specific message)
            // or standard 429.
            const resetHeader = response.headers.get('x-ratelimit-reset');
            const retryAfter = response.headers.get('retry-after');
            const hasHeader = Boolean(resetHeader || retryAfter);

            let waitMs;
            if (resetHeader) {
                // Unix timestamp (seconds)
                const resetTime = parseInt(resetHeader, 10) * 1000;
                waitMs = Math.max(0, resetTime - Date.now()) + 5000; // Add 5s buffer
            } else if (retryAfter) {
                // Seconds or Date string
                const seconds = parseInt(retryAfter, 10);
                waitMs = (!isNaN(seconds) ? seconds * 1000 : (new Date(retryAfter).getTime() - Date.now())) + 2000;
            } else if (attempt === undefined) {
                // V28: Legacy callers (no attempt arg; they maintain their own retry
                // counters): preserve the original flat 60s header-less wait — ZERO
                // behavior change.
                waitMs = MAX_SINGLE_WAIT_MS; // 60000
            } else {
                // V28: Converted callers (pass a numeric attempt) — circuit breaker +
                // exponential escalation by attempt.
                if (attempt >= MAX_429_ATTEMPTS) {
                    console.error(`\n🔥 [Rate Limit] ${this.sourceName.toUpperCase()} exhausted ${MAX_429_ATTEMPTS} header-less attempts (Status ${response.status}). Aborting fetch.`);
                    throw new RateLimitExceededError(this.sourceName, `${MAX_429_ATTEMPTS} attempts`);
                }
                const jitter = Math.random() * 1000;
                waitMs = Math.min(BASE_BACKOFF_MS * 2 ** attempt + jitter, MAX_SINGLE_WAIT_MS);
            }

            const waitSec = (waitMs / 1000).toFixed(1);

            // V22.3: Threshold Enforcement — never honor a single server-provided
            // wait longer than 5 minutes (header-less waits are already capped at
            // MAX_SINGLE_WAIT_MS, so this only fires for explicit retry headers).
            const MAX_WAIT_MS = 5 * 60 * 1000;
            if (hasHeader && waitMs > MAX_WAIT_MS) {
                console.error(`\n🔥 [Rate Limit] ${this.sourceName.toUpperCase()} wait too long (${waitSec}s). Aborting fetch.`);
                throw new RateLimitExceededError(this.sourceName, waitSec);
            }

            const attemptLabel = attempt === undefined ? 'legacy' : `attempt ${attempt}`;
            console.warn(`\n🛑 [Rate Limit] ${this.sourceName.toUpperCase()} throttling (Status ${response.status}, ${attemptLabel}). Waiting ${waitSec}s...`);

            await this.delay(waitMs);
            return true;
        }
        return false;
    }

    /**
     * Fetch with an AbortController timeout (V28: harvest hardening).
     * Shared helper so academic adapters (arxiv/s2/deepspec) — which currently
     * have NO fetch timeout and can hang a CI job indefinitely — can adopt a
     * bounded request. Mirrors the proven pattern in ar5iv-fetcher.js.
     *
     * @param {string} url - Request URL
     * @param {Object} [options={}] - fetch() options (merged with the abort signal)
     * @param {number} [timeoutMs=30000] - Abort window in milliseconds
     * @returns {Promise<Response>} The fetch Response
     * @throws {Error} AbortError (name === 'AbortError') if the request exceeds timeoutMs
     */
    async fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
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
