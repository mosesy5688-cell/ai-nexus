/**
 * ENT-503 review M1/R1 — exact-case precedence for the entity route's
 * case-folded shard match.
 *
 * The route matches lower(id|slug|umid) so a row stored with uppercase is
 * reachable (the id-index keys are lowercased; stored casing is not normalized
 * on the pack write path). Case-folding must never change WHICH entity
 * origin/main served. Production routes rows by their RAW slug
 * (pack-db.js computeMetaShardSlot(e.slug || e.id), no lowercasing) and the
 * index's lowercased keys are first-wins, so case twins usually sit on
 * DIFFERENT shards and the index may resolve the uppercase twin's shard first.
 * Hence, across the whole probe loop:
 *
 *   - "exact" = a row whose id / slug / umid equals one of the probe forms
 *     case-sensitively — exactly what origin/main's SQL (`id IN (forms) OR
 *     slug IN (forms) OR umid IN (forms)`) matched. The raw request id is NOT
 *     added (origin/main lowercased it into the forms).
 *   - a shard with exact rows ends the loop with ONLY those rows;
 *   - a shard with only case-folded rows does NOT end the loop: the first such
 *     set is kept as a FALLBACK and probing continues for an exact row;
 *   - the fallback is used only if no exact row was found anywhere AND the loop
 *     finished cleanly (no budget bail, no shard error). Otherwise the caller
 *     keeps its 503 / 404 semantics unchanged.
 */
export interface CaseFold<T> {
    /** Rows to answer with now (exact-case, non-empty) or [] to keep probing. */
    take(rows: T[], forms: string[]): T[];
    /** Fold-only fallback, released only for a cleanly completed loop. */
    fallback(clean: boolean): T[];
}

type Row = { id?: any; slug?: any; umid?: any };

export function exactCaseRows<T extends Row>(rows: T[], forms: string[]): T[] {
    const exact = new Set<string>(forms);
    const hit = (v: any) => typeof v === 'string' && exact.has(v);
    return rows.filter(r => hit(r.id) || hit(r.slug) || hit(r.umid));
}

export function makeCaseFold<T extends Row>(): CaseFold<T> {
    let fold: T[] = [];
    return {
        take(rows, forms) {
            const exact = exactCaseRows(rows, forms);
            if (exact.length > 0) return exact;
            if (fold.length === 0) fold = rows;
            return [];
        },
        fallback(clean) {
            return clean ? fold : [];
        },
    };
}
