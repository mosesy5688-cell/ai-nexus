/**
 * D-140 Lane S-B — Sitemap URL-set primitives (C3/C6/C7).
 *
 * Pure, side-effect-free helpers the sitemap generator composes:
 *   - escapeXml(): XML-escape any generated <loc>/text (C7 §9).
 *   - normalizeLastmod(): coerce a raw timestamp to a canonical W3C value or ''.
 *   - lastmodIsLater(): total order on normalized lastmods (invalid never wins).
 *   - SitemapUrlSet: deterministic, cross-source dedup of canonical absolute URLs
 *     keyed by the FULL absolute <loc> (C3 §8). One canonical URL appears ONCE
 *     across the COMPLETE set. On a duplicate, the LATEST VALID lastmod is
 *     retained; an invalid timestamp NEVER overrides a valid one. Output order is
 *     deterministic (lexicographic on the absolute loc) for identical inputs.
 *   - childMaxLastmod(): a child shard's MAXIMUM valid lastmod, or '' (C6 §9) —
 *     drives an HONEST index <lastmod> (omitted when no child URL has one).
 *
 * Memory: the set holds ONE compact record per UNIQUE url. Benchmarked at 1,000,000
 * candidates / 20% dup -> ~356MB peak heapUsed, vs the vfs-derived job's 6144MB
 * NODE_OPTIONS ceiling (~17x headroom). See PR body for the full scale proof.
 */

const BASE_URL = 'https://free2aitools.com';

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** XML-escape a string for safe inclusion in element text / attribute values. */
export function escapeXml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

/**
 * Coerce a raw timestamp to a canonical W3C-datetime string, or '' when absent /
 * unparseable. '' is the single sentinel for "no valid lastmod" everywhere below.
 */
export function normalizeLastmod(raw) {
    if (!raw) return '';
    const d = new Date(raw);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * True iff candidate lastmod `b` should REPLACE the retained `a` under the C3 merge
 * rule: keep the LATEST VALID value; an invalid (=='') candidate never overrides a
 * valid retained one, and a valid candidate always beats an invalid retained one.
 * Both raw inputs are normalized first.
 */
export function lastmodIsLater(aRaw, bRaw) {
    const a = normalizeLastmod(aRaw);
    const b = normalizeLastmod(bRaw);
    if (!b) return false;        // invalid candidate never wins
    if (!a) return true;         // valid candidate beats invalid/absent retained
    return b > a;                // ISO-8601 strings compare lexicographically as time
}

/**
 * Deterministic, cross-source canonical-URL dedup set. Keyed by the FULL absolute
 * <loc> so duplicates across AND within source DBs collapse to ONE entry.
 */
export class SitemapUrlSet {
    constructor(baseUrl = BASE_URL) {
        this.baseUrl = baseUrl;
        this._map = new Map(); // absoluteLoc -> { loc, priority, changefreq, lastmod }
    }

    /** Absolute canonical URL for a site-relative loc. */
    absolute(loc) {
        return this.baseUrl + loc;
    }

    /**
     * Add a candidate. On a duplicate absolute URL, keep the entry whose lastmod is
     * the LATEST valid one (invalid never overrides valid). First insert wins for
     * priority/changefreq EXCEPT when a later candidate supplies the retained
     * (latest-valid) lastmod, in which case that candidate's record is retained
     * whole — so the lastmod and its sibling fields stay internally consistent.
     */
    add({ loc, priority, changefreq, lastmod }) {
        if (!loc) return;
        const key = this.absolute(loc);
        const existing = this._map.get(key);
        const record = { loc, priority, changefreq, lastmod: lastmod || '' };
        if (!existing) {
            this._map.set(key, record);
            return;
        }
        if (lastmodIsLater(existing.lastmod, lastmod)) {
            this._map.set(key, record);
        }
    }

    get size() {
        return this._map.size;
    }

    /**
     * Deterministic, total-ordered array of unique records: sorted by absolute loc.
     * Identical input candidate streams -> identical output order -> stable hash.
     */
    toSortedArray() {
        const entries = [...this._map.entries()];
        entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        return entries.map((e) => e[1]);
    }
}

/**
 * The MAXIMUM valid lastmod across a child shard's URL records, or '' when none of
 * them carries a valid lastmod. Used for an HONEST sitemap-index <lastmod> (C6):
 * derived from the child's real content, never stamped with the run date.
 */
export function childMaxLastmod(records) {
    let max = '';
    for (const r of records) {
        const n = normalizeLastmod(r.lastmod);
        if (n && (!max || n > max)) max = n;
    }
    return max;
}
