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

// P3-EVIDENCE-1: title-mandatory citation contract. Placeholder/non-title tokens
// FORBIDDEN as a title (an id/canonical-id/hash/slug/"Unknown" masquerading as a
// real title is fabricated provenance). A bare word with no whitespace that also
// equals the entity id/slug is treated as an id residue, not a genuine title.
const PLACEHOLDER_TITLE = /^(unknown|untitled|n\/?a|none|null|undefined)$/i;
// A bare 16+ hex string is a umid/content-hash residue, never a genuine title.
const HASH_TITLE = /^[0-9a-f]{16,}$/i;
// year sanity floor/ceiling mirrors v25-distiller's published_year validation.
const YEAR_MIN = 1990;
const YEAR_MAX = 2100;

/** Trimmed non-empty string, else null. No coercion of non-strings. */
function cleanStr(v) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t : null;
}

/** A genuine, explicitly-present title - never an id/slug/hash/placeholder. */
function resolveTitle(entity) {
    const candidate = cleanStr(entity.name) || cleanStr(entity.title) || cleanStr(entity.displayName);
    if (!candidate) return null;
    if (PLACEHOLDER_TITLE.test(candidate)) return null;
    if (HASH_TITLE.test(candidate)) return null;
    // Reject an id/slug/canonical-id echoed into the title field (id-as-title).
    const idForms = [entity.id, entity.slug, entity.canonical_id, entity.umid]
        .filter(v => typeof v === 'string' && v).map(v => v.trim());
    if (idForms.includes(candidate)) return null;
    return candidate;
}

/**
 * Resolve a usable author component (string | string[] | object[] with .name).
 * Drops unusable members; returns null when none remain (author then OMITTED).
 */
function resolveAuthor(entity) {
    const a = entity.author;
    if (typeof a === 'string') return cleanStr(a);
    if (!Array.isArray(a)) return null;
    const names = [];
    for (const m of a) {
        if (typeof m === 'string') { const s = cleanStr(m); if (s) names.push(s); }
        else if (m && typeof m === 'object') { const s = cleanStr(m.name); if (s) names.push(s); }
    }
    return names.length ? names.join(' and ') : null;
}

/** Explicit structured source publication year only; never the current/bake year. */
function resolveYear(entity) {
    let raw = entity.published_year;
    if (raw == null) {
        const meta = typeof entity.meta_json === 'object' && entity.meta_json ? entity.meta_json : {};
        const date = meta.published_date || entity.published_date || null;
        raw = date ? new Date(date).getFullYear() : null;
    }
    const yr = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(yr) || isNaN(yr) || yr <= YEAR_MIN || yr >= YEAR_MAX) return null;
    return yr;
}

/** A real, external source URL only - never an internal free2aitools route. */
function resolveUrl(entity) {
    const candidates = [entity.source_url,
        entity.links && entity.links.source, entity.links && entity.links.html];
    for (const c of candidates) {
        const s = cleanStr(c);
        if (!s) continue;
        if (/free2aitools\.com/i.test(s)) continue;      // internal route residue
        if (/^https?:\/\//i.test(s)) return s;
    }
    return null;
}

/**
 * Pure, deterministic citation normalizer (no I/O). Title is MANDATORY; author,
 * year, url are optional and OMITTED (never empty-shelled / fabricated) when
 * absent. Returns a BibTeX @misc string, or null when no genuine title exists.
 * @param {object} entity
 * @returns {string|null}
 */
export function normalizeCitation(entity) {
    if (!entity || typeof entity !== 'object') return null;
    const title = resolveTitle(entity);
    if (!title) return null;                              // title-mandatory: no fabricated presence

    // Cite key MAY be the id/hash - but it never doubles as the human title above.
    const keySource = cleanStr(entity.id) || title;
    const citeKey = keySource.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);

    const parts = [`title={${title}}`];
    const author = resolveAuthor(entity);
    if (author) parts.push(`author={${author}}`);
    const year = resolveYear(entity);
    if (year != null) parts.push(`year={${year}}`);
    const url = resolveUrl(entity);
    if (url) parts.push(`url={${url}}`);
    parts.push('note={Indexed by Free2AITools}');
    return `@misc{${citeKey},${parts.join(',')}}`;
}

/**
 * Generate academic BibTeX citation string (CDDPP Shield).
 * Delegates to the pure normalizeCitation contract (P3-EVIDENCE-1).
 * @param {object} entity
 * @returns {string|null} BibTeX citation, or null when no genuine title exists.
 */
export function generateCitation(entity) {
    return normalizeCitation(entity);
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
