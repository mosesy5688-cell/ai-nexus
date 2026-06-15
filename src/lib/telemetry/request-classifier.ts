/**
 * P2 Adoption Telemetry -- PURE request-path classifier (TA2 instrumentation).
 *
 * Authority: Founder DISPOSITION D-2026-0615-53 (CONTROLLING) O-1 (cache_class
 * origin-observed), O-3 (unknown MCP tool -> no emit), O-4 (method gate /
 * surface map), O-8 (audience fixed-precedence allowlist), O-9 (UTC hour
 * bucket). North-star (SPEC s31-32): "P2 measures dependence; it does not
 * monetize, rank, recommend, or gate."
 *
 * THIS MODULE IS PURE: no I/O, no console.*, no env deref, no binding token,
 * never a Request/URL/Headers/body input. It takes ALREADY-EXTRACTED primitives
 * (the call site -- middleware/mcp/datasets, which are NOT telemetry modules --
 * does the extraction) and returns a fully-formed TelemetryEvent or null (null =
 * drop, no emit). It NEVER puts a raw value (ua/referer/path/id/query) into the
 * returned object or into any reason/fallback. ASCII-only (CES Art 8.1).
 */
import { SCHEMA_VERSION, type TelemetryEvent } from './schema';
import {
  statusToClass, classifyRefererHost, classifyAudience,
  type Surface, type McpTool, type CacheClass, type AudienceClass,
} from './vocab';

// ---- O-4 SURFACE MAP (EXACT-ONLY families, never a permissive prefix) ---------
// Dynamic segments are matched by an EXACT grammar (not startsWith) so unapproved
// NEIGHBORS (/api/v1/trendsetter, /api/v1/badge/a/b, /api/v1/entity/) map to null,
// never an approved surface. The matched segment is DISCARDED (never an event
// field). MCP + datasets are route-owned (not here). /api/search (internal engine)
// is EXCLUDED by Founder D-53 (NOT COUNTED) -> absent here -> null.
const EXACT_GET: Record<string, Surface> = {
  '/api/v1/search': 'api.v1.search',
  '/api/v1/compare': 'api.v1.compare',
  '/api/v1/concepts': 'api.v1.concepts',
  // api.v1.trends: the SOLE approved public surface is the EXACT batch path;
  // /api/v1/trends, /api/v1/trends-anything, /api/v1/trendsetter,
  // /api/v1/trends/batch/extra all fall through to null (no overmatch).
  '/api/v1/trends/batch': 'api.v1.trends',
  '/llms.txt': 'discovery.llms_txt',
  '/openapi.json': 'discovery.openapi',
};

// EXACT single-non-empty-segment grammar: matches "/<prefix>/<seg>" where <seg>
// is non-empty and has NO further '/'. Bare "/<prefix>/" and deeper "/a/b" -> null.
function matchSingleSegment(pathname: string, prefix: string, surface: Surface): Surface | null {
  if (!pathname.startsWith(prefix)) return null;
  const seg = pathname.slice(prefix.length);
  if (seg.length === 0) return null;       // bare "/<prefix>/" -> null
  if (seg.includes('/')) return null;      // deeper "/<prefix>/a/b" -> null
  return surface;
}

/** O-4 canonical-method gate + EXACT family surface map for middleware-owned
 *  routes. Returns the closed Surface or null (drop). select is POST-only;
 *  everything else mapped here is GET-only. /api/mcp + /api/v1/datasets are
 *  EXCLUDED (the routes own them) and unrecognized / neighbor paths return null. */
export function classifyRestSurface(method: string, pathname: string): Surface | null {
  const m = method.toUpperCase();
  if (pathname === '/api/v1/select') return m === 'POST' ? 'api.v1.select' : null;
  if (m !== 'GET') return null;
  const exact = EXACT_GET[pathname];
  if (exact) return exact;
  // badge: exactly ONE non-empty single segment after "/api/v1/badge/".
  const badge = matchSingleSegment(pathname, '/api/v1/badge/', 'badge');
  if (badge) return badge;
  // entity: the route is the [...id] catch-all; require a NON-EMPTY remainder
  // after "/api/v1/entity/" (ids may contain slashes, so only the empty
  // remainder is rejected -- "/api/v1/entity/" -> null).
  if (pathname.startsWith('/api/v1/entity/') && pathname.length > '/api/v1/entity/'.length) {
    return 'api.v1.entity';
  }
  return null;
}

// ---- O-8 audience: fixed lowercase substring allowlists (match case-insens) ---
// Raw UA is NEVER stored/returned; only these closed signatures are tested.
const BOT_TOKENS = [
  'bot', 'crawler', 'spider', 'slurp', 'bingpreview', 'googlebot',
  'bingbot', 'duckduckbot', 'baiduspider', 'yandex', 'facebookexternalhit',
];
const BROWSER_TOKENS = ['mozilla', 'applewebkit', 'gecko', 'chrome', 'safari', 'firefox', 'edge'];
const API_CLIENT_TOKENS = [
  'curl', 'wget', 'python-requests', 'httpie', 'postmanruntime',
  'go-http-client', 'axios',
];
const hasToken = (lower: string, tokens: string[]): boolean =>
  tokens.some((t) => lower.includes(t));

/** O-8 conservative fixed-precedence audience derivation from already-extracted
 *  primitives. O-8 precedence is (1) mcp_client, (2) first_party, ...; the shared
 *  vocab.classifyAudience checks first_party before mcp_client, so to honor the
 *  O-8 ordering WITHOUT modifying the frozen vocab we suppress isFirstParty when
 *  the request is an MCP client (MCP wins). In practice the MCP call site already
 *  passes isFirstParty=false, so this only hardens the precedence contract.
 *  Never auto-external_api for non-browser/empty UA; ambiguous never -> mcp_client.
 *  Returns the closed enum; undecidable -> 'unknown'. */
export function classifyRequestAudience(
  isMcpClient: boolean, isFirstParty: boolean, uaString: string | null,
): AudienceClass {
  const lower = (uaString || '').toLowerCase();
  return classifyAudience({
    isMcpClient,
    isFirstParty: isMcpClient ? false : isFirstParty,
    isBot: !!lower && hasToken(lower, BOT_TOKENS),
    isBrowser: !!lower && hasToken(lower, BROWSER_TOKENS),
    isApiClient: !!lower && hasToken(lower, API_CLIENT_TOKENS),
  });
}

// ---- O-9 UTC hour bucket "YYYY-MM-DDTHH" -------------------------------------
function timeBucket(now: Date | number): string {
  const d = typeof now === 'number' ? new Date(now) : now;
  return d.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
}

// ---- O-1 cache_class (ORIGIN-OBSERVED, never edge truth) ----------------------
// 304 -> 'hit'. A trusted project-owned explicit MISS signal -> 'miss' (no such
// signal exists today, so 'miss' is simply never produced). Everything else
// (ordinary 200, redirect, MCP, POST select, uncacheable) -> 'none'. NEVER infer
// hit from Cache-Control; NEVER auto-miss a plain 200; NEVER read CF-Cache-Status.
function cacheClass(status: number, trustedMiss: boolean): CacheClass {
  if (status === 304) return 'hit';
  if (trustedMiss) return 'miss';
  return 'none';
}

/** Closed primitive input to the REST/discovery event builder. ONLY primitives
 *  -- never a Request/URL/Headers/body. */
export interface ClassifyInput {
  method: string;
  pathname: string;
  uaString: string | null;
  refererHost: string | null;
  ownHost: string | null;
  status: number;
  trustedCacheMiss?: boolean;
  now: Date | number;
}

/** Build a fully-formed TelemetryEvent for a middleware-owned REST/discovery
 *  surface, or null (drop). operation is null for all REST/discovery surfaces.
 *  Returns ONLY the 8 closed-enum keys; never any raw value. */
export function buildRestEvent(input: ClassifyInput): TelemetryEvent | null {
  const surface = classifyRestSurface(input.method, input.pathname);
  if (!surface) return null;
  return {
    schema_version: SCHEMA_VERSION,
    surface,
    operation: null,
    status_class: statusToClass(input.status),
    cache_class: cacheClass(input.status, !!input.trustedCacheMiss),
    audience_class: classifyRequestAudience(false, isFirstParty(input.refererHost, input.ownHost), input.uaString),
    referer_host_class: classifyRefererHost(input.refererHost, input.ownHost ?? undefined),
    time_bucket: timeBucket(input.now),
  };
}

function isFirstParty(refererHost: string | null, ownHost: string | null): boolean {
  return !!refererHost && !!ownHost && refererHost.toLowerCase() === ownHost.toLowerCase();
}

// ---- O-3 MCP surface/operation classifier (route-owned) -----------------------
// Maps the FULL MCP tool name (e.g. 'free2aitools_compare') to the frozen enum.
const MCP_TOOL_MAP: Record<string, McpTool> = {
  free2aitools_search: 'search',
  free2aitools_rank: 'rank',
  free2aitools_explain: 'explain',
  free2aitools_select_model: 'select_model',
  free2aitools_compare: 'compare',
};

/** O-3 MCP classification. 'initialize' -> {mcp.initialize, null}. 'tools/call'
 *  with a tool name mapping to one of the 5 frozen enums -> {mcp.tools_call,
 *  <enum>}. tools/list / invalid / unknown method / unknown tool / missing name
 *  -> null (NO emit). Never returns the raw tool name. */
export function classifyMcp(
  method: string | null, toolName: string | null,
): { surface: Surface; operation: McpTool | null } | null {
  if (method === 'initialize') return { surface: 'mcp.initialize', operation: null };
  if (method === 'tools/call') {
    if (!toolName) return null;
    const op = MCP_TOOL_MAP[toolName];
    if (!op) return null;
    return { surface: 'mcp.tools_call', operation: op };
  }
  return null;
}

/** Closed primitive input to the MCP event builder. */
export interface McpClassifyInput {
  method: string | null;
  toolName: string | null;
  uaString: string | null;
  refererHost: string | null;
  ownHost: string | null;
  status: number;
  now: Date | number;
}

/** Build a fully-formed MCP TelemetryEvent or null. MCP is never cacheable
 *  (cache_class always 'none') and audience is always mcp_client (the request
 *  arrived via the MCP dispatch surface, O-8 precedence (1)). */
export function buildMcpEvent(input: McpClassifyInput): TelemetryEvent | null {
  const c = classifyMcp(input.method, input.toolName);
  if (!c) return null;
  return {
    schema_version: SCHEMA_VERSION,
    surface: c.surface,
    operation: c.operation,
    status_class: statusToClass(input.status),
    cache_class: 'none',
    audience_class: classifyRequestAudience(true, false, input.uaString),
    referer_host_class: classifyRefererHost(input.refererHost, input.ownHost ?? undefined),
    time_bucket: timeBucket(input.now),
  };
}

/** O-2 datasets: returns 'datasets.302' ONLY when a real known-file 302 is
 *  issued, else null (manifest 200 / unknown-file 404 -> null). */
export function classifyDatasets(isRealKnownFile302: boolean): Surface | null {
  return isRealKnownFile302 ? 'datasets.302' : null;
}

/** Closed primitive input to the datasets event builder. */
export interface DatasetsClassifyInput {
  isRealKnownFile302: boolean;
  uaString: string | null;
  refererHost: string | null;
  ownHost: string | null;
  now: Date | number;
}

/** Build the datasets.302 TelemetryEvent (status_class 3xx) or null. */
export function buildDatasetsEvent(input: DatasetsClassifyInput): TelemetryEvent | null {
  const surface = classifyDatasets(input.isRealKnownFile302);
  if (!surface) return null;
  return {
    schema_version: SCHEMA_VERSION,
    surface,
    operation: null,
    status_class: '3xx',
    cache_class: 'none',
    audience_class: classifyRequestAudience(false, isFirstParty(input.refererHost, input.ownHost), input.uaString),
    referer_host_class: classifyRefererHost(input.refererHost, input.ownHost ?? undefined),
    time_bucket: timeBucket(input.now),
  };
}
