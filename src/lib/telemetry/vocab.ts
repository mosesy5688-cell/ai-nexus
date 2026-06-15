/**
 * P2 Adoption Telemetry -- CLOSED-WORLD VOCABULARIES + pure classifiers.
 *
 * Authority: FREE2AITOOLS_ADOPTION_TELEMETRY_DESIGN_SPEC_v0.txt (v0.1 FINAL
 * RATIFIED, Errata #1-#4) + the Founder DISPOSITION (D-2026-0615-49) at the end
 * of the Phase-A implementation-gate proposal. North-star (SPEC s31-32):
 * "P2 measures dependence; it does not monetize, rank, recommend, or gate."
 *
 * This module is VOCAB + CLASSIFIER ONLY (TA1 substrate). It wires NOTHING to a
 * call site (that is TA2). Every export is a closed enum or a PURE function that
 * maps ALREADY-EXTRACTED, already-classed inputs to a closed class. It NEVER
 * reads a Request/URL/Headers/body, never stores a raw UA/IP/referer/path, and
 * never returns anything outside the frozen sets below (SPEC s5 closed-world:
 * "nothing outside this list, ever", line 133). ASCII-only (CES Art 8.1).
 */

// ---- SURFACE / ROUTE-FAMILY vocabulary (SPEC s5 COUNTED list; CODE-verified) -
// REST route families (counted at the HTTP boundary by family, NOT by path):
export const ROUTE_FAMILIES = [
  'api.v1.search', 'api.v1.entity', 'api.v1.compare',
  'api.v1.select', 'api.v1.concepts', 'api.v1.trends',
] as const;
// Discovery + integration surfaces:
export const DISCOVERY_SURFACES = [
  'discovery.llms_txt', 'discovery.openapi', 'badge', 'datasets.302',
] as const;
// MCP surfaces (dispatch-point count; SPEC s5 lines 109-110):
export const MCP_SURFACES = ['mcp.initialize', 'mcp.tools_call'] as const;

export const SURFACES = [
  ...ROUTE_FAMILIES, ...DISCOVERY_SURFACES, ...MCP_SURFACES,
] as const;
export type Surface = (typeof SURFACES)[number];

// ---- MCP TOOL vocabulary (closed: exactly the 5 tools; SPEC s5 line 110) -----
// The operation field for mcp.tools_call. NEVER the call arguments (D-49 D:
// "MCP handler passes ONLY the parsed method + closed tool-name enum").
export const MCP_TOOLS = [
  'search', 'rank', 'explain', 'select_model', 'compare',
] as const;
export type McpTool = (typeof MCP_TOOLS)[number];

// ---- STATUS CLASS (Erratum #4: 2xx|3xx|4xx|5xx; 302 -> 3xx, never faked 2xx) -
export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

// ---- AUDIENCE CLASS (SPEC s5 line 140 canonical enum; undecidable -> unknown) -
export const AUDIENCE_CLASSES = [
  'human_browser', 'external_api', 'mcp_client',
  'bot_crawler', 'first_party', 'unknown',
] as const;
export type AudienceClass = (typeof AUDIENCE_CLASSES)[number];

// ---- CACHE / RESULT CLASS (SPEC s5 line 138 cache status) --------------------
export const CACHE_CLASSES = ['hit', 'miss', 'none'] as const;
export type CacheClass = (typeof CACHE_CLASSES)[number];

// ---- REFERER HOST CLASS (closed allowlist + 'other' + 'none'; SPEC s5 l136) --
// An UNLISTED host is NEVER stored raw, not even in raw rows -> mapped to 'other'.
export const REFERER_HOST_CLASSES = [
  'github', 'huggingface', 'arxiv', 'google', 'reddit',
  'first_party', 'other', 'none',
] as const;
export type RefererHostClass = (typeof REFERER_HOST_CLASSES)[number];

// Allowlist of known platform hosts -> closed class. NO raw host is ever stored;
// an unlisted host collapses to 'other' before it can reach the event.
const HOST_ALLOWLIST: Record<string, RefererHostClass> = {
  'github.com': 'github', 'github.io': 'github', 'githubusercontent.com': 'github',
  'huggingface.co': 'huggingface',
  'arxiv.org': 'arxiv',
  'google.com': 'google',
  'reddit.com': 'reddit',
};

function isClass<T extends readonly string[]>(set: T, v: unknown): v is T[number] {
  return typeof v === 'string' && (set as readonly string[]).includes(v);
}

export const isSurface = (v: unknown): v is Surface => isClass(SURFACES, v);
export const isMcpTool = (v: unknown): v is McpTool => isClass(MCP_TOOLS, v);
export const isStatusClass = (v: unknown): v is StatusClass => isClass(STATUS_CLASSES, v);
export const isAudienceClass = (v: unknown): v is AudienceClass => isClass(AUDIENCE_CLASSES, v);
export const isCacheClass = (v: unknown): v is CacheClass => isClass(CACHE_CLASSES, v);
export const isRefererHostClass = (v: unknown): v is RefererHostClass =>
  isClass(REFERER_HOST_CLASSES, v);

/**
 * statusToClass -- coarse HTTP status code -> closed class. PURE; input is an
 * already-known numeric status, never a Response/body. 302 -> '3xx' (Erratum #4).
 * Out-of-range -> '5xx' floor (never throws, never widens the enum).
 */
export function statusToClass(status: number): StatusClass {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  return '5xx';
}

/**
 * classifyRefererHost -- an ALREADY-EXTRACTED hostname (caller parsed it; this
 * fn never touches a URL/Headers) -> closed host class. Own host => 'first_party'.
 * Empty/absent => 'none'. Unlisted => 'other'. Raw host is NEVER returned.
 */
export function classifyRefererHost(host: string | null | undefined, ownHost?: string): RefererHostClass {
  if (!host) return 'none';
  const h = host.toLowerCase();
  if (ownHost && h === ownHost.toLowerCase()) return 'first_party';
  for (const [domain, cls] of Object.entries(HOST_ALLOWLIST)) {
    if (h === domain || h.endsWith('.' + domain)) return cls;
  }
  return 'other';
}

/**
 * classifyAudience -- maps a small set of ALREADY-DERIVED boolean hints (never a
 * raw UA string; the caller in TA2 derives these server-side) to the closed
 * audience enum. Undecidable -> 'unknown' (SPEC s5 line 141: never force-classify
 * as external adoption). Raw UA is NEVER an input or output here.
 */
export interface AudienceHints {
  isFirstParty?: boolean;   // own-host referer / browser context
  isBot?: boolean;          // known crawler UA class (pre-derived)
  isMcpClient?: boolean;    // request arrived via the MCP dispatch surface
  isBrowser?: boolean;      // browser UA class (pre-derived)
  isApiClient?: boolean;    // non-browser programmatic client (pre-derived)
}
export function classifyAudience(hints: AudienceHints): AudienceClass {
  if (hints.isFirstParty) return 'first_party';
  if (hints.isMcpClient) return 'mcp_client';
  if (hints.isBot) return 'bot_crawler';
  if (hints.isBrowser) return 'human_browser';
  if (hints.isApiClient) return 'external_api';
  return 'unknown';
}
