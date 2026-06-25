/**
 * Common shared types for the Free2AITools REST SDK.
 *
 * DESIGN: the catalog is append-only / ever-growing, so EVERY response type is
 * NON-EXHAUSTIVE. Known fields are typed; unknown additive fields are preserved
 * via an index signature (`[k: string]: unknown`). The SDK never strips or throws
 * on extra keys. See the contract baseline, Section 2.
 */

/** Escape hatch every response object carries: tolerate unknown additive fields. */
export interface Open {
  [k: string]: unknown;
}

/** Search result `type` enum (also used by search() request). */
export type EntityType =
  | "all"
  | "model"
  | "tool"
  | "dataset"
  | "paper"
  | "benchmark";

/**
 * The `semantic` FNI factor is ALWAYS null by contract (it is a query-time
 * baseline, not a per-entity value). Never coerce to 0 or a number. The
 * accompanying `*_note` string MUST be surfaced. See Section 6.
 */
export type SemanticFactor = null;

/** FNI factor block as it appears on entity/select/compare responses. */
export interface FniFactors extends Open {
  /** ALWAYS null by contract. Do not coerce. */
  semantic: SemanticFactor;
  /** Caveat explaining why `semantic` is null. Surface verbatim. */
  semantic_note: string;
  authority: number | null;
  popularity: number | null;
  recency: number | null;
  quality: number | null;
}

/** A nullable numeric stat: null = not-measured, 0 = a true zero. */
export type NullableCount = number | null;
