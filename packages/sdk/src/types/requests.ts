/**
 * Typed REST request shapes. Defaults / ranges follow the REST contract
 * (Section 3) — NOT the MCP defaults. The SDK is a REST client.
 */
import type { EntityType } from "./common.js";

export interface SearchRequest {
  /** REQUIRED. */
  q: string;
  /** default "all". One of: all|model|tool|dataset|paper|benchmark. */
  type?: EntityType;
  /** REST default 5, clamped to [1,20] by the server. (MCP default is 10 — not used here.) */
  limit?: number;
  /** 1-based page (default 1). Best-effort offset paging; NO snapshot consistency. */
  page?: number;
}

export interface GetEntityRequest {
  /** REQUIRED path id. Tolerant: canonical | HF-native | slug | UMID. */
  id: string;
  /** CSV; "body" lazy-loads readme_html (papers return null body by legal gate). */
  include?: string;
}

export interface SelectConstraints {
  max_vram_gb?: number;
  max_params_b?: number;
  /** "commercial" | "any" | a specific license string. */
  license?: string;
  min_context_length?: number;
  ollama_compatible?: boolean;
  can_run_local?: boolean;
  hosted_on?: string;
  /** permissive | copyleft | non-commercial | any. */
  license_type?: string;
}

export interface SelectRequest {
  /** REQUIRED. */
  task: string;
  constraints?: SelectConstraints;
  /** default 5, clamped [1,20]. */
  limit?: number;
  /** default true. */
  explain?: boolean;
}

export interface CompareRequest {
  /** REQUIRED; 2..25 ids. */
  ids: string[];
}

export interface ConceptsRequest {
  /** default 50, range 1..200. */
  limit?: number;
  /** default 0, >= 0. (Offset/limit pagination — NOT page-based.) */
  offset?: number;
  /** regex ^[a-z][a-z0-9-]{0,40}$ */
  category?: string;
}

export interface TrendsBatchRequest {
  /** REQUIRED; 1..25 ids. */
  ids: string[];
}

export interface DatasetsRequest {
  /** When present, the listing entry's download_url is the CDN target. */
  file?: string;
}
