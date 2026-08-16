/**
 * R-1 render-layer honesty primitives (D-2026-0816-436 sec A, items T1/T2/T4/T6).
 *
 * Charter P2 (No Fake Density): the render layer must never dress an empty
 * record as an evidenced page. These helpers are the single place where the
 * render layer decides "do we actually know this?" so every surface answers
 * the question the same way.
 *
 * Two distinct honest states, never conflated:
 *   UNKNOWN       - we have no value. Omit the field / omit the citation
 *                   component. NEVER substitute today's date, the current
 *                   year, or an invented author.
 *   MEASURED-ZERO - we looked and the value is 0 / false / "". That is data,
 *                   not absence, and it must keep rendering as 0 / false.
 */

/** Year window a rendered publication year must fall inside to be credible. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

/**
 * Absence markers a pipeline can emit. String forms matter: null/undefined
 * survive JSON/SQLite round-trips as the literal text "null"/"None", and the
 * render layer used to print that text verbatim as if it were a value.
 */
const UNKNOWN_TEXT = new Set(['', 'null', 'undefined', 'none', 'nan', 'n/a', 'na', '-']);

/**
 * True when the value is real data worth rendering.
 * 0, false and "0" are KNOWN (measured zero), not absence.
 */
export function isKnown(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return true;
    if (typeof value === 'string') return !UNKNOWN_TEXT.has(value.trim().toLowerCase());
    if (Array.isArray(value)) return value.length > 0;
    return true;
}

/** Trimmed string when the value is real text, otherwise null. Never a placeholder. */
export function knownText(value: unknown): string | null {
    if (!isKnown(value) || typeof value !== 'string') {
        return isKnown(value) && typeof value === 'number' ? String(value) : null;
    }
    return value.trim();
}

/**
 * Parse a publication year from whatever the pipeline stored, WITHOUT ever
 * fabricating one.
 *
 * The 1970 defect this replaces: `published_year` is stored as a bare integer
 * (e.g. 2026). `new Date(2026)` reads 2026 as epoch-MILLISECONDS, lands on
 * 1970-01-01, and the old guard (`y > 1900`) happily passed 1970 through. A
 * bare year must therefore be recognised as a year BEFORE any Date parsing.
 *
 * Returns null (unknown) rather than guessing. Never returns the current year
 * as a fallback.
 */
export function parseHonestYear(raw: unknown): number | null {
    if (!isKnown(raw)) return null;

    const numeric = typeof raw === 'number'
        ? raw
        : (/^\s*-?\d+(\.\d+)?\s*$/.test(String(raw)) ? Number(raw) : NaN);

    if (Number.isFinite(numeric)) {
        // Bare calendar year (the observed live shape: published_year = 2026).
        if (Number.isInteger(numeric) && numeric > MIN_YEAR && numeric < MAX_YEAR) return numeric;
        // Defensive epoch handling. No live instance of either shape was found
        // in the 30-sample census behind D-436 T2, but both are unambiguous:
        // ~1e8..1e11 can only be epoch seconds, >=1e11 can only be epoch ms.
        const abs = Math.abs(numeric);
        if (abs >= 1e8 && abs < 1e11) return yearWithin(numeric * 1000);
        if (abs >= 1e11) return yearWithin(numeric);
        return null;
    }

    const parsed = Date.parse(String(raw).trim());
    return Number.isFinite(parsed) ? yearWithin(parsed) : null;
}

function yearWithin(epochMs: number): number | null {
    const y = new Date(epochMs).getUTCFullYear();
    return Number.isFinite(y) && y > MIN_YEAR && y < MAX_YEAR ? y : null;
}

/**
 * The entity's real publication year, or null. Field order follows the
 * hydrator (entity-type-handlers promotes published_date from meta_json;
 * the distiller emits published_year as a bare int).
 */
export function resolveEntityYear(entity: any): number | null {
    if (!entity) return null;
    const candidates = [
        entity.published_date,
        entity.published_year,
        entity.year,
        entity?.meta?.extended?.published_date,
        entity?.meta?.extended?.year
    ];
    for (const raw of candidates) {
        const y = parseHonestYear(raw);
        if (y !== null) return y;
    }
    return null;
}

/**
 * The entity's real author/organisation, or null.
 * Rejects the pipeline's own placeholder tokens so the render layer cannot
 * re-launder them ("Unknown" from a producer is still "we do not know").
 */
const PLACEHOLDER_AUTHORS = new Set(['unknown', 'community', 'independent / community',
    'research community', 'free2aitools contributors', 'anonymous', 'n/a',
    'open source']);

export function honestAuthor(...candidates: unknown[]): string | null {
    for (const c of candidates) {
        const t = knownText(c);
        if (t && !PLACEHOLDER_AUTHORS.has(t.toLowerCase())) return t;
    }
    return null;
}

/**
 * The entity's real license, or null (D-436 T3).
 *
 * The "License Unknown" caution banner is driven off a single field
 * (`license_spdx`) while the rest of the page reads `license` /
 * `meta_json.license`. When they disagree the SAME page both asserts a license
 * and warns that none is known. One resolver, one answer.
 */
export function honestLicense(entity: any): string | null {
    if (!entity) return null;
    return knownText(entity.license_spdx)
        ?? knownText(entity.license)
        ?? knownText(entity?.meta_json?.license)
        ?? knownText(entity?.meta?.license);
}

/**
 * Typed honest meta description for entities with no real abstract/description
 * (D-436 T5, option B). States what the page IS - a registry entry - without
 * pretending descriptive content exists.
 */
export function registryEntryDescription(type: string, name: string): string {
    const t = knownText(type) || 'entity';
    const n = knownText(name) || 'this entry';
    return `Registry entry for ${t} ${n}; source metadata pending.`;
}
