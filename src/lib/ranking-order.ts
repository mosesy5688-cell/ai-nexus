/**
 * Commercialization-Constitution C4 — "Sponsors Never Influence Structure".
 *
 * THE un-buyable ranking comparator. This is the JS mirror of the live SQL
 * ordering in src/pages/api/v1/select.ts:
 *
 *     ORDER BY (CASE WHEN params_billions > 0 THEN 0 ELSE 1 END), fni_score DESC
 *
 * It is factored out into a SHARED module so the C4 anti-arbitration canary
 * (tests/unit/c4-anti-arbitration.test.ts) exercises the EXACT ordering the
 * serve path uses, not a hand-copied lookalike that could silently drift.
 *
 * C4 INVARIANT (enforced by the canary + the static gate):
 *   No payment signal (sponsor / tier / customer / paid / billing / promoted /
 *   boost / bid) may EVER appear in this comparator or in any factor that feeds
 *   fni_score. Order derives PURELY from public FNI factors + the public
 *   params-presence tie-break above. Paid tiers buy quota / compute / access /
 *   freshness ONLY -- never one byte of order or score.
 *
 * If a future edit needs to read a paid signal here to change order, that edit
 * is a C4 violation by construction: STOP and route it through a separate,
 * clearly-labelled "commercial recommendations" surface that is physically
 * disjoint from this comparator (see src/pages/methodology.astro Radical
 * Neutrality). Do not add a paid branch to compareForRanking.
 */

/** The minimal shape compareForRanking reads. Only public FNI structure. */
export interface RankableRow {
  fni_score?: number | null;
  params_billions?: number | null;
}

/**
 * Primary sort key: models WITH a known parameter count rank ahead of those
 * without (0 before 1), mirroring the SQL CASE. This is a public completeness
 * signal, NOT a paid signal.
 */
export function paramsPresenceKey(row: RankableRow): 0 | 1 {
  const p = row?.params_billions;
  return typeof p === 'number' && p > 0 ? 0 : 1;
}

/** FNI score as a finite number; null/undefined/NaN treated as 0 (SQL DESC). */
export function fniScoreKey(row: RankableRow): number {
  const s = row?.fni_score;
  return typeof s === 'number' && Number.isFinite(s) ? s : 0;
}

/**
 * Deterministic comparator matching select.ts's ORDER BY. Public factors only.
 * Returns <0 if a ranks before b. Ties are left to the caller's stable sort so
 * ordering is fully reproducible (no payment-derived tie-break — that is the
 * whole point of C4).
 */
export function compareForRanking(a: RankableRow, b: RankableRow): number {
  const pk = paramsPresenceKey(a) - paramsPresenceKey(b);
  if (pk !== 0) return pk;            // params-present rows first
  return fniScoreKey(b) - fniScoreKey(a); // then fni_score DESC
}

/**
 * Order a candidate list exactly as the serve path would. Uses a stable sort
 * (Array.prototype.sort is stable in V8/modern engines) so equal-key rows keep
 * input order -- reproducible, payment-agnostic.
 */
export function orderCandidates<T extends RankableRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareForRanking);
}
