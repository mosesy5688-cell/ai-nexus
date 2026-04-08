/**
 * V25.8 UMID Generator - Universal Mesh ID
 *
 * Generates deterministic, immutable UMIDs via HMAC-SHA256.
 * UMID is anchored to the canonical entity ID and a private salt,
 * ensuring permanence regardless of name/author changes.
 *
 * Output: 16-char hex string (64-bit equivalent)
 */

import crypto from 'crypto';

const UMID_LENGTH = 16; // 64-bit hex representation
let _saltWarned = false;

/**
 * Generate a deterministic UMID for an entity.
 * @param {string} canonicalId - The entity's canonical ID (e.g., 'hf-model--meta-llama--llama-3')
 * @returns {string} A 16-char hex UMID
 */
export function generateUMID(canonicalId) {
    if (!canonicalId) throw new Error('UMID generation requires a canonical ID');
    const salt = process.env.UMID_SALT;
    if (!salt && !_saltWarned) {
        console.warn('[UMID] UMID_SALT not set. Using fallback salt (NOT production-safe).');
        _saltWarned = true;
    }
    const hmac = crypto.createHmac('sha256', salt || 'nexus-dev-salt-v25.8');
    hmac.update(canonicalId);
    return hmac.digest('hex').substring(0, UMID_LENGTH);
}

const DEV_FALLBACK_SALT = 'nexus-dev-salt-v25.8';

/**
 * Generate UMID using the legacy dev-salt (for backward-compatible enrichment lookup).
 * Only differs from generateUMID when production UMID_SALT is set.
 * @param {string} canonicalId
 * @returns {string} 16-char hex UMID using dev salt
 */
export function generateDevUMID(canonicalId) {
    if (!canonicalId) return '';
    const hmac = crypto.createHmac('sha256', DEV_FALLBACK_SALT);
    hmac.update(canonicalId);
    return hmac.digest('hex').substring(0, UMID_LENGTH);
}

/**
 * Compute shard slot from UMID (Phase 1: JS-based routing).
 * Will be replaced by Rust FFI xxhash64 in Phase 3.
 * @param {string} umid - The 16-char hex UMID
 * @param {number} totalSlots - Number of logical slots (default 4096)
 * @returns {number} Slot index 0..totalSlots-1
 */
export function computeShardSlot(umid, totalSlots = 4096) {
    // If input is not a hex UMID (e.g. slug/id fallback), hash it first for uniform distribution
    let hex = umid;
    if (!/^[0-9a-f]{8,}$/i.test(umid)) {
        hex = crypto.createHash('md5').update(umid).digest('hex');
    }
    const hash32 = parseInt(hex.substring(0, 8), 16) >>> 0;
    return hash32 % totalSlots;
}

/**
 * Generate canonical_url for SEO authority anchoring (CDDPP Shield).
 * @param {object} entity - Entity with type and slug/id
 * @returns {string} The canonical URL
 */
export function generateCanonicalUrl(entity) {
    const type = entity.type || 'model';
    const slug = entity.slug || entity.id || '';
    const typePlural = {
        model: 'models', paper: 'papers', dataset: 'datasets',
        tool: 'tools', agent: 'agents', space: 'spaces', prompt: 'prompts'
    };
    const section = typePlural[type] || `${type}s`;
    return `https://free2aitools.com/${section}/${encodeURIComponent(slug)}`;
}

/**
 * Generate academic BibTeX citation string (CDDPP Shield).
 * @param {object} entity - Entity with name, author, type
 * @returns {string} BibTeX citation
 */
export function generateCitation(entity) {
    const name = entity.name || entity.displayName || entity.id || 'Unknown';
    const author = Array.isArray(entity.author)
        ? entity.author.join(' and ')
        : (entity.author || 'Unknown');
    const year = new Date().getFullYear();
    const citeKey = (entity.id || name).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);

    return `@misc{${citeKey},title={${name}},author={${author}},year={${year}},url={${generateCanonicalUrl(entity)}},note={Indexed by Free2AITools}}`;
}

/**
 * Batch-stamp UMIDs on an array of entities.
 * @param {Array} entities - Entity array
 * @returns {Map<string, string>} id -> umid mapping
 */
export function batchStampUMIDs(entities) {
    const mapping = new Map();
    let stamped = 0;

    for (const entity of entities) {
        const id = entity.id || entity.slug;
        if (!id) continue;

        if (!entity.umid) {
            entity.umid = generateUMID(id);
            stamped++;
        }
        mapping.set(id, entity.umid);
    }

    console.log(`[UMID] Stamped ${stamped} new UMIDs (${mapping.size} total mapped)`);
    return mapping;
}
