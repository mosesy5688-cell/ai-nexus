/**
 * C4 Stage 1 — shared PURE entity-match resolver (serving-layer identity parity).
 *
 * The producer can store TWO typed records that share ONE slug (e.g.
 * hf-model--google-bert--bert-base-uncased AND hf-dataset--google-bert--
 * bert-base-uncased), and the packer co-locates them on the SAME
 * xxhash64(slug) meta shard. The old serving code selected a row with
 * `... LIMIT 1` and no type filter / no ORDER BY, so entity/human/compare each
 * picked a different rowid-winner for the same identity — the surfaces
 * DISAGREED (G1). This module centralizes ONE deterministic, type-aware,
 * order-independent selection over the bounded co-resident candidate set.
 *
 * PURE: no SQL, no fetch, no shard/rowid logic, no I/O. The caller fetches the
 * small candidate set (bounded multi-row) and hands the raw rows here; this
 * only SELECTS. Correctness MUST NOT depend on candidate order or rowid —
 * reversing the input array cannot change the result (dedupe + sort first).
 *
 * It preserves BOTH twins: each is retrievable by its EXACT typed canonical id;
 * a bare/untyped identifier that maps to >1 typed record is surfaced as an
 * explicit AMBIGUITY, never silently collapsed to one (no arbitrary first-row
 * win). It NEVER fuses sources or adjudicates real-world equivalence.
 */
import { SLUG_PREFIXES } from './slug-helper.js';

/** Raw entities row. The resolver reads ONLY id/type/slug/umid. */
export interface ResolverRow {
    id: string;
    type: string;
    slug?: string | null;
    umid?: string | null;
    [k: string]: any;
}

/** Public candidate projection — ONLY {id, type}. Never shard/rowid/internal. */
export interface PublicCandidate {
    id: string;
    type: string;
}

/**
 * Closed discriminated result. Every branch is explicit; no null/undefined.
 * `candidate_overflow` is an ADDITIVE optional flag on AMBIGUOUS: true when the
 * deduped unique count exceeded MAX_PUBLIC_CANDIDATES, so the bounded fetch window
 * could not PROVE uniqueness and a P3/P4 single-match downgrades to explicit
 * ambiguity (never a false unique). Exact canonical-id / UMID stays authoritative.
 */
export type EntityMatchResult =
    | { kind: 'FOUND'; row: ResolverRow }
    | { kind: 'NOT_FOUND' }
    | { kind: 'AMBIGUOUS'; candidates: PublicCandidate[]; candidate_overflow?: true }
    | { kind: 'IDENTITY_TYPE_CONFLICT'; row: ResolverRow; candidates: PublicCandidate[] };

/**
 * Public-candidate cap AND the overflow threshold: a deduped unique count GREATER
 * than this means the bounded fetch window could not prove uniqueness. One slug
 * shard co-resides 2-3 twins; this is a structural guard — a pathological set stays
 * AMBIGUOUS (fail explicit, candidate_overflow:true), NEVER a truncated false unique.
 */
export const MAX_PUBLIC_CANDIDATES = 25;
/** SQL row-fetch cap: ONE more than the public cap so the resolver can DETECT overflow. */
export const CANDIDATE_FETCH_LIMIT = 26;
/** @deprecated back-compat alias for MAX_PUBLIC_CANDIDATES (identical value). */
export const MAX_CANDIDATES = MAX_PUBLIC_CANDIDATES;

const lc = (s: any): string => (typeof s === 'string' ? s.toLowerCase() : '');
const typeEq = (a: any, b: any): boolean => lc(a) !== '' && lc(a) === lc(b);

// Longest-first so `hf-model` wins over the bare `model` when matching a prefix.
const PREFIXES_LONGEST_FIRST = [...SLUG_PREFIXES].sort((a, b) => b.length - a.length);

/**
 * Derive the entity TYPE encoded by a canonical id's source-qualified prefix.
 *   hf-model--x -> 'model', gh-tool--x -> 'tool', arxiv-paper--x -> 'paper',
 *   arxiv--x -> 'paper' (source==type), benchmark--x -> 'benchmark',
 *   bare dataset--x -> 'dataset'.
 * Returns null when the id carries no recognized `<prefix>--` (bare slug/name).
 */
export function prefixEntityType(id: string): string | null {
    const lower = lc(id);
    for (const p of PREFIXES_LONGEST_FIRST) {
        if (lower.startsWith(`${p}--`)) {
            if (p === 'arxiv') return 'paper'; // arxiv source's type is paper
            const dash = p.indexOf('-');
            return dash === -1 ? p : p.slice(dash + 1);
        }
    }
    return null;
}

/** Stable comparator: type ASC, then id ASC (both case-insensitive). */
function byTypeThenId(a: { id: string; type: string }, b: { id: string; type: string }): number {
    if (lc(a.type) !== lc(b.type)) return lc(a.type) < lc(b.type) ? -1 : 1;
    if (lc(a.id) !== lc(b.id)) return lc(a.id) < lc(b.id) ? -1 : 1;
    return 0;
}

/** Dedupe raw rows by lowercased id; sort deterministically (order-independent). */
function dedupeRows(rows: ResolverRow[]): ResolverRow[] {
    const seen = new Set<string>();
    const out: ResolverRow[] = [];
    for (const r of rows || []) {
        if (!r || typeof r.id !== 'string' || r.id === '') continue;
        const key = lc(r.id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    out.sort(byTypeThenId);
    return out;
}

/** Public {id,type} projection: deduped, sorted, bounded. No internal fields. */
function publicCandidates(rows: ResolverRow[]): PublicCandidate[] {
    const seen = new Set<string>();
    const out: PublicCandidate[] = [];
    for (const r of rows) {
        const key = lc(r.id);
        if (!r.id || seen.has(key)) continue;
        seen.add(key);
        out.push({ id: r.id, type: r.type });
    }
    out.sort(byTypeThenId);
    return out.length > MAX_PUBLIC_CANDIDATES ? out.slice(0, MAX_PUBLIC_CANDIDATES) : out;
}

/**
 * Select the single correct record for `requestedId` from the co-resident
 * candidate rows. `requestedType` is the authoritative ROUTE type when the
 * caller is a typed human route (model/dataset/...); null for the entity/compare
 * APIs, which instead derive the type from the id's own prefix.
 *
 * Priority (order-independent — dedupe+sort runs first):
 *  1. EXACT canonical-id match. If the id carries a type prefix and the matched
 *     row's type CONFLICTS with it -> IDENTITY_TYPE_CONFLICT; else FOUND.
 *  2. EXACT umid match.
 *  3. TYPE-CONSTRAINED slug selection (route type wins, else the id-prefix type):
 *     the unique row of that type -> FOUND; none of that type -> NOT_FOUND (never
 *     hand back another type's row); >1 of that type -> AMBIGUOUS.
 *  4. UNTYPED bare identifier: exactly one candidate -> FOUND.
 *  5. UNTYPED bare identifier mapping to >1 typed record -> AMBIGUOUS.
 */
export function resolveEntityMatch(
    requestedId: string,
    requestedType: string | null | undefined,
    candidateRows: ResolverRow[],
): EntityMatchResult {
    const rows = dedupeRows(candidateRows);
    const reqLower = lc(requestedId).trim();
    const reqType = requestedType ? lc(requestedType) : null;
    const prefixType = prefixEntityType(reqLower);

    // OVERFLOW — deduped unique count exceeded the public cap, so the bounded fetch
    // window (CANDIDATE_FETCH_LIMIT) can no longer PROVE a slug/type match unique (a
    // same-slug twin may sit in the un-fetched tail). A P3/P4 fallback single-match
    // downgrades to explicit AMBIGUOUS(candidate_overflow:true), never a false unique.
    // P1 exact-id / P2 umid stay authoritative — the caller SQL binds id+umid in
    // ORDER BY so an exact row, if it exists, is always in the window.
    const overflow = rows.length > MAX_PUBLIC_CANDIDATES;
    const ambiguous = (cands: PublicCandidate[]): EntityMatchResult =>
        overflow ? { kind: 'AMBIGUOUS', candidates: cands, candidate_overflow: true }
                 : { kind: 'AMBIGUOUS', candidates: cands };

    // P1 — exact canonical id (authoritative even under overflow).
    const exact = reqLower !== '' ? rows.find(r => lc(r.id) === reqLower) : undefined;
    if (exact) {
        if (prefixType && !typeEq(exact.type, prefixType)) {
            return { kind: 'IDENTITY_TYPE_CONFLICT', row: exact, candidates: publicCandidates(rows) };
        }
        // A route type is authoritative: never return a wrong-typed row on a
        // typed route — fall through to the type-constrained filter below.
        if (!reqType || typeEq(exact.type, reqType)) {
            return { kind: 'FOUND', row: exact };
        }
    }

    // P2 — exact umid (authoritative even under overflow).
    const umidHit = reqLower !== '' ? rows.find(r => r.umid && lc(r.umid) === reqLower) : undefined;
    if (umidHit && (!reqType || typeEq(umidHit.type, reqType))) {
        return { kind: 'FOUND', row: umidHit };
    }

    // P3 — type-constrained slug selection (route type OR id-prefix type).
    const constraintType = reqType || prefixType;
    if (constraintType) {
        const typed = rows.filter(r => typeEq(r.type, constraintType));
        if (typed.length === 0) return { kind: 'NOT_FOUND' };
        // Under overflow a single typed match is NOT provably unique -> ambiguous.
        if (typed.length === 1 && !overflow) return { kind: 'FOUND', row: typed[0] };
        return ambiguous(publicCandidates(overflow ? rows : typed));
    }

    // P4/P5 — untyped bare identifier. Under overflow (>25 rows) the single-match
    // FOUND is unreachable; the multi-match branch returns AMBIGUOUS + overflow.
    if (rows.length === 0) return { kind: 'NOT_FOUND' };
    if (rows.length === 1) return { kind: 'FOUND', row: rows[0] };
    return ambiguous(publicCandidates(rows));
}
