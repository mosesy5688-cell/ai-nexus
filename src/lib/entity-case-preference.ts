/**
 * ENT-503 review M1 — exact-case preference for the entity route's case-folded
 * shard match.
 *
 * The route matches lower(id|slug|umid) so a row stored with uppercase is
 * reachable (the id-index keys are lowercased; stored casing is not normalized
 * on the pack write path). Case-folding must not change WHICH entity is served
 * when origin/main's case-sensitive match already found one:
 *
 *   - if any fetched row matches a probe form or the raw requested id EXACTLY
 *     (case-sensitive) on id / slug / umid, keep ONLY those rows — the same row
 *     set the pre-fold SQL returned (the route's ORDER BY ranks exact rows
 *     ahead of fold-only rows, so the LIMIT window holds them first);
 *   - otherwise (no exact row) keep the fold-only rows: a new true positive for
 *     an entity stored only with uppercase.
 *
 * Pure; never invents a row, only narrows the fetched window.
 */
export function preferExactCase<T extends { id?: any; slug?: any; umid?: any }>(rows: T[], forms: string[], rawId: string): T[] {
    const exact = new Set<string>(forms);
    if (rawId) exact.add(rawId);
    const hit = (v: any) => typeof v === 'string' && exact.has(v);
    const exactRows = rows.filter(r => hit(r.id) || hit(r.slug) || hit(r.umid));
    return exactRows.length > 0 ? exactRows : rows;
}
