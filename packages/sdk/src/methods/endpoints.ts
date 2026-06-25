/**
 * Pure request builders: turn typed requests into CoreRequest objects (url,
 * method, idempotency, sanitized context). No network here — the client passes
 * these to the HTTP core. This keeps route paths / params / limits in ONE place
 * so the contract baseline (Sections 1-3) is auditable at a glance.
 */
import { buildQuery, buildUrl, sanitizeParams } from "../http/query.js";
import type { CoreRequest } from "../http/client-core.js";
import {
  clampLimit,
  normalizeOffset,
  normalizePage,
  requireIdCount,
  requireNonEmptyString,
} from "./validate.js";
import type {
  CompareRequest,
  ConceptsRequest,
  DatasetsRequest,
  GetEntityRequest,
  SearchRequest,
  SelectRequest,
  TrendsBatchRequest,
} from "../types/requests.js";

function get(baseUrl: string, path: string, params: Record<string, unknown>): CoreRequest {
  const query = buildQuery(params as Record<string, string | number | boolean | null | undefined>);
  return {
    method: "GET",
    url: buildUrl(baseUrl, path, query),
    idempotent: true,
    context: { method: "GET", path, params: sanitizeParams(params) },
  };
}

export function healthRequest(baseUrl: string): CoreRequest {
  return get(baseUrl, "/api/v1/health", {});
}

export function searchRequest(baseUrl: string, req: SearchRequest): CoreRequest {
  const q = requireNonEmptyString(req.q, "q");
  return get(baseUrl, "/api/v1/search", {
    q,
    type: req.type ?? "all",
    limit: clampLimit(req.limit, 1, 20, 5),
    page: normalizePage(req.page),
  });
}

export function entityRequest(baseUrl: string, req: GetEntityRequest): CoreRequest {
  const id = requireNonEmptyString(req.id, "id");
  const path = `/api/v1/entity/${encodeURIComponent(id)}`;
  return get(baseUrl, path, req.include ? { include: req.include } : {});
}

export function compareRequest(baseUrl: string, req: CompareRequest): CoreRequest {
  const ids = requireIdCount(req.ids, "ids", 2, 25);
  return get(baseUrl, "/api/v1/compare", { ids: ids.join(",") });
}

export function conceptsRequest(baseUrl: string, req: ConceptsRequest = {}): CoreRequest {
  const params: Record<string, unknown> = {
    limit: clampLimit(req.limit, 1, 200, 50),
    offset: normalizeOffset(req.offset),
  };
  if (req.category !== undefined) params.category = req.category;
  return get(baseUrl, "/api/v1/concepts", params);
}

export function trendsBatchRequest(baseUrl: string, req: TrendsBatchRequest): CoreRequest {
  const ids = requireIdCount(req.ids, "ids", 1, 25);
  return get(baseUrl, "/api/v1/trends/batch", { ids: ids.join(",") });
}

export function datasetsRequest(baseUrl: string, req: DatasetsRequest = {}): CoreRequest {
  return get(baseUrl, "/api/v1/datasets", req.file ? { file: req.file } : {});
}

/** select() is POST — idempotent:false => NO auto-retry even on 503 (Section 5). */
export function selectRequest(baseUrl: string, req: SelectRequest): CoreRequest {
  const task = requireNonEmptyString(req.task, "task");
  const body: Record<string, unknown> = {
    task,
    limit: clampLimit(req.limit, 1, 20, 5),
    explain: req.explain ?? true,
  };
  if (req.constraints) body.constraints = req.constraints;
  const path = "/api/v1/select";
  return {
    method: "POST",
    url: buildUrl(baseUrl, path),
    idempotent: false,
    body,
    context: {
      method: "POST",
      path,
      params: sanitizeParams({ task, limit: body.limit, explain: body.explain, constraints: req.constraints }),
    },
  };
}
