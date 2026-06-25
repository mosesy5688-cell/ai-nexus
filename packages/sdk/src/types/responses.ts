/**
 * Typed REST response shapes, grounded in the contract baseline (Section 2).
 * All interfaces extend `Open` so unknown additive fields are preserved.
 */
import type { Open, FniFactors, NullableCount, EntityType } from "./common.js";

export interface HealthResponse extends Open {
  version: string;
  status: string;
  timestamp: string;
  vfs: Open | { error: string };
  runtime: { node_compat: boolean; now_ms: number };
  meta: { elapsed_ms: number; isolate_random_id: string };
}

export interface SearchResult extends Open {
  id: string;
  slug: string;
  name: string;
  type: string;
  author: string | null;
  summary: string | null;
  fni_score: number;
  /** ALWAYS null by contract. */
  fni_s: null;
  fni_s_note?: string;
  fni_a: number;
  fni_p: number;
  fni_r: number;
  fni_q: number;
  stars: NullableCount;
  downloads: number;
  last_modified: string;
  license: string | null;
  pipeline_tag: string | null;
  params_billions: number;
  context_length: number;
}

/** NOTE: `elapsed_ms` is TOP-LEVEL here (no meta wrapper). Section 2. */
export interface SearchResponse extends Open {
  version: string;
  results: SearchResult[];
  total_count: number;
  tier: string;
  elapsed_ms: number;
}

export interface Fni extends Open {
  score: number | null;
  percentile: number | null;
  factors: FniFactors;
  is_trending: boolean;
  trend_7d: unknown | null;
}

export interface EntityBody extends Open {
  /** null by L1 legal gate for papers (not an error). */
  readme_html: string | null;
  has_fulltext: boolean;
  source_url?: string;
}

export interface Entity extends Open {
  id: string;
  canonical_id: string;
  slug: string;
  type: string;
  arxiv_id: string | null;
  name: string;
  author: string | null;
  source: string | null;
  summary: string | null;
  category: string | null;
  tags: string[];
  license: string | null;
  license_type: string | null;
  pipeline_tag: string | null;
  task_categories: string[];
  primary_language: string | null;
  primary_category: string | null;
  published_year: number | null;
  fni: Fni;
  specs: Open;
  stats: Open;
  links: Open;
  relations: Open;
  citation: string | null;
  quick_start: string | null;
  body?: EntityBody;
}

export interface EntityResponse extends Open {
  version: string;
  entity: Entity;
  meta: { elapsed_ms: number; etag: string | null; candidates_tried: number };
}

export interface SelectEntry extends Open {
  rank: number;
  model_id: string;
  name: string;
  author: string | null;
  fni_score: number;
  fni_factors: FniFactors;
  params_billions: number | null;
  vram_estimate_gb: number | null;
  context_length: number | null;
  license: string | null;
  pipeline_tag: string | null;
  ollama_compatible: boolean;
  hosted_on: string[];
  license_type: string;
  can_run_local: boolean;
  detail_url: string;
  badge_url: string;
  /** Only present when explain=true. A FACTUAL factor summary, NOT a verdict. */
  fni_summary?: string;
  /** Only present when explain=true. Honest caveats; never a recommendation. */
  caveats?: string[];
}

export interface SelectResponse extends Open {
  version: string;
  task_interpreted: string;
  total_candidates: number;
  entries: SelectEntry[];
  meta: { elapsed_ms: number };
}

export interface CompareEntity extends Open {
  id: string;
  name: string;
  author: string | null;
  type: string;
  fni_score: number;
  fni_factors: FniFactors;
  specs: Open;
  popularity: { downloads: number; stars: number };
  last_modified: string;
  detail_url: string;
  badge_url: string;
  found: true;
}

export interface CompareMiss extends Open {
  id: string;
  found: false;
}

export interface CompareResponse extends Open {
  version: string;
  entities: Array<CompareEntity | CompareMiss>;
  meta: { elapsed_ms: number; found: number; requested: number };
}

export interface Concept extends Open {
  id: string;
  slug: string;
  umid: string | null;
  title: string;
  subtitle: string | null;
  summary: string | null;
  category: string | null;
  tags: string[];
  author: string | null;
  word_count: number;
  published_at: string | null;
  updated_at: string | null;
  canonical_url: string | null;
}

/** version is "knowledge_v1" (the ONE endpoint that differs). */
export interface ConceptsResponse extends Open {
  version: string;
  total_count: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  category: string | null;
  concepts: Concept[];
  meta: { elapsed_ms: number; etag: string | null };
}

export interface TrendEntry extends Open {
  scores: number[];
  dates: string[];
  change7d: number;
  direction: "up" | "down" | "stable";
  latest: number;
}

export interface TrendsBatchResponse extends Open {
  version: string;
  trends: Record<string, TrendEntry>;
  missing: string[];
  meta: { elapsed_ms: number; found: number; requested: number };
}

export interface DatasetFile extends Open {
  id: string;
  name: string;
  tier: string;
  fields: string[];
  download_url: string;
  api_url: string;
}

export interface DatasetsResponse extends Open {
  version: string;
  description: string;
  files: DatasetFile[];
}

export { EntityType };
