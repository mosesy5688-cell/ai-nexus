/**
 * Free2AIClient — the public REST client for Free2AITools.
 *
 * CALLER-FINAL-DECISION: every method RETRIEVES candidates / evidence /
 * rankings. None of them assert "best", guarantee compatibility, or make the
 * final choice. The caller decides. (Honest-contract; see README.)
 *
 * Method set (REST): health, search, getEntity, select, compare, getConcepts,
 * getTrendsBatch, listDatasets, getEntityEvidence (local convenience), badgeUrl
 * (pure URL builder). rank() and explain() are MCP-ONLY (no REST route) and are
 * intentionally absent — inventing a REST route would be scope expansion.
 */
import {
  type CallOptions,
  type Free2AIClientOptions,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { type CoreRequest, execute } from "./http/client-core.js";
import { badgeUrl as buildBadgeUrl } from "./methods/badge.js";
import { getEntityEvidence } from "./methods/evidence.js";
import * as ep from "./methods/endpoints.js";
import type {
  CompareRequest,
  ConceptsRequest,
  DatasetsRequest,
  GetEntityRequest,
  SearchRequest,
  SelectRequest,
  TrendsBatchRequest,
} from "./types/requests.js";
import type {
  CompareResponse,
  ConceptsResponse,
  DatasetsResponse,
  EntityResponse,
  HealthResponse,
  SearchResponse,
  SelectResponse,
  TrendsBatchResponse,
} from "./types/responses.js";

export class Free2AIClient {
  private readonly cfg: ResolvedConfig;

  constructor(options: Free2AIClientOptions = {}) {
    this.cfg = resolveConfig(options);
  }

  /** The resolved base URL this client targets. */
  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  /**
   * `build` is a thunk so that client-side validation throws (e.g. a missing
   * required param) surface as a REJECTED promise, not a synchronous throw —
   * every public method has uniform Promise error semantics.
   */
  private async send<T>(build: () => CoreRequest, opts?: CallOptions): Promise<T> {
    const req = build();
    return execute<T>(
      { ...req, signal: opts?.signal },
      {
        fetchImpl: this.cfg.fetchImpl,
        timeoutMs: this.cfg.timeoutMs,
        retry: this.cfg.retry,
        signal: this.cfg.signal,
      },
    );
  }

  /** GET /api/v1/health — per-isolate observability snapshot (not a global metric). */
  health(opts?: CallOptions): Promise<HealthResponse> {
    return this.send<HealthResponse>(() => ep.healthRequest(this.cfg.baseUrl), opts);
  }

  /**
   * GET /api/v1/search — keyword discovery. Default limit 5 (REST), 1-based page.
   * Best-effort offset paging; NO snapshot consistency (data is append-only).
   * Retrieves candidates with FNI evidence; does not rank a single "best".
   */
  search(req: SearchRequest, opts?: CallOptions): Promise<SearchResponse> {
    return this.send<SearchResponse>(() => ep.searchRequest(this.cfg.baseUrl, req), opts);
  }

  /**
   * GET /api/v1/entity/{id} — tolerant id lookup (canonical|HF|slug|UMID).
   * 404 = proven absence (typed NotFound); 503 = transient (typed Unavailable,
   * retried). Use include:"body" to lazy-load readme (papers return null body).
   */
  getEntity(req: GetEntityRequest, opts?: CallOptions): Promise<EntityResponse> {
    return this.send<EntityResponse>(() => ep.entityRequest(this.cfg.baseUrl, req), opts);
  }

  /**
   * POST /api/v1/select — task + constraints => ranked candidates with caveats.
   * NON-idempotent: NOT auto-retried, even on 503 (surfaced as a typed error).
   * Returns evidence + caveats; the caller makes the final choice.
   */
  select(req: SelectRequest, opts?: CallOptions): Promise<SelectResponse> {
    return this.send<SelectResponse>(() => ep.selectRequest(this.cfg.baseUrl, req), opts);
  }

  /**
   * GET /api/v1/compare — 2..25 ids, returned in request order. Unresolved ids
   * come back as { id, found:false } (honest absence, never silently dropped).
   */
  compare(req: CompareRequest, opts?: CallOptions): Promise<CompareResponse> {
    return this.send<CompareResponse>(() => ep.compareRequest(this.cfg.baseUrl, req), opts);
  }

  /**
   * GET /api/v1/concepts — knowledge concepts. OFFSET/LIMIT pagination (NOT
   * page-based) + next_offset. Uses a DIFFERENT error envelope; the SDK maps it.
   */
  getConcepts(req: ConceptsRequest = {}, opts?: CallOptions): Promise<ConceptsResponse> {
    return this.send<ConceptsResponse>(() => ep.conceptsRequest(this.cfg.baseUrl, req), opts);
  }

  /** GET /api/v1/trends/batch — 1..25 ids => 7-day FNI series; missing[] = honest absence. */
  getTrendsBatch(req: TrendsBatchRequest, opts?: CallOptions): Promise<TrendsBatchResponse> {
    return this.send<TrendsBatchResponse>(() => ep.trendsBatchRequest(this.cfg.baseUrl, req), opts);
  }

  /** GET /api/v1/datasets — dataset listing (download URLs; does not stream bytes). */
  listDatasets(req: DatasetsRequest = {}, opts?: CallOptions): Promise<DatasetsResponse> {
    return this.send<DatasetsResponse>(() => ep.datasetsRequest(this.cfg.baseUrl, req), opts);
  }

  /**
   * Local convenience: re-shape evidence from a getEntity() response. NO remote
   * call, NO FNI recompute. Preserves all evidence + caveats + semantic_note.
   * This is NOT the MCP "explain" tool.
   */
  getEntityEvidence = getEntityEvidence;

  /** Pure URL builder for an entity badge SVG. Does NOT fetch. */
  badgeUrl(idOrSlug: string): string {
    return buildBadgeUrl(this.cfg.baseUrl, idOrSlug);
  }
}
