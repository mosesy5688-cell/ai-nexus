/**
 * getEntityEvidence() — a documented CLIENT CONVENIENCE (Section 7).
 *
 * It performs NO remote call and NO FNI recompute. It re-shapes evidence that
 * an existing getEntity() response ALREADY carries: fni.factors (+ semantic_note
 * caveat), score/percentile, relations, citation, stats, source/links. All
 * evidence + caveats are preserved verbatim; null-by-contract fields stay null.
 *
 * This is NOT the MCP "explain" tool (which is a server computation with no REST
 * route). It only surfaces what the entity response already proved.
 */
import type { Entity, EntityResponse, Fni } from "../types/responses.js";

export interface EntityEvidence {
  id: string;
  canonical_id: string;
  /** Honest scope: canonical_id is a reproducible identity FORM, not proven provenance. */
  identity_note: string;
  source: string | null;
  links: Record<string, unknown>;
  fni: Fni;
  /** Surfaced verbatim from fni.factors.semantic_note. Never dropped. */
  semantic_note: string;
  relations: Record<string, unknown>;
  citation: string | null;
  stats: Record<string, unknown>;
  /** Caller-final-decision reminder: evidence only; the caller decides. */
  disclaimer: string;
}

const IDENTITY_NOTE =
  "canonical_id is a deterministic, externally reproducible identity form, NOT proven external provenance.";

const DISCLAIMER =
  "Evidence and FNI factors only. This SDK retrieves the evidence; it does not assert a best choice or guarantee compatibility. The caller makes the final decision.";

/**
 * Parse evidence out of a getEntity() response. Accepts either the full
 * EntityResponse or a bare Entity. Pure, synchronous, no network.
 */
export function getEntityEvidence(input: EntityResponse | Entity): EntityEvidence {
  const maybeWrapped = input as { entity?: Entity };
  const entity: Entity = maybeWrapped.entity ?? (input as Entity);
  const fni = entity.fni;
  const semanticNote =
    fni && fni.factors ? fni.factors.semantic_note : "";
  return {
    id: entity.id,
    canonical_id: entity.canonical_id,
    identity_note: IDENTITY_NOTE,
    source: entity.source,
    links: (entity.links ?? {}) as Record<string, unknown>,
    fni,
    semantic_note: semanticNote,
    relations: (entity.relations ?? {}) as Record<string, unknown>,
    citation: entity.citation,
    stats: (entity.stats ?? {}) as Record<string, unknown>,
    disclaimer: DISCLAIMER,
  };
}
