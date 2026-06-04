/**
 * UMID Generator - Universal Mesh ID
 *
 * Generates deterministic, immutable UMIDs via plain SHA-256 of the canonical
 * entity ID (no salt). UMID is anchored to the public canonical ID, so any
 * external party can recompute it — it is publicly verifiable.
 *
 * UMID = SHA256(canonical_id) first 64 bits = first 16 hex chars.
 * Output: 16-char hex string (64-bit equivalent).
 */

import crypto from 'crypto';

const UMID_LENGTH = 16; // 64-bit hex representation

/**
 * Generate a deterministic, publicly-verifiable UMID for an entity.
 * @param {string} canonicalId - The entity's canonical ID (e.g., 'hf-model--meta-llama--llama-3')
 * @returns {string} A 16-char hex UMID = SHA256(canonicalId)[0..16]
 */
export function generateUMID(canonicalId) {
    if (!canonicalId) throw new Error('UMID generation requires a canonical ID');
    return crypto.createHash('sha256').update(canonicalId).digest('hex').substring(0, UMID_LENGTH);
}

/**
 * Legacy alias of generateUMID. UMID is now unsalted, so there is no longer a
 * dev-vs-prod distinction — both resolve to SHA256(canonicalId)[0..16]. Kept as
 * an alias for backward-compatible callers (e.g. enrichment-lookup fallback).
 * @param {string} canonicalId
 * @returns {string} 16-char hex UMID (empty string for falsy input)
 */
export function generateDevUMID(canonicalId) {
    if (!canonicalId) return '';
    return generateUMID(canonicalId);
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
