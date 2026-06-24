/**
 * P2 Adoption Telemetry -- ROUTE-LOCAL pure pre-classifiers (TA2 seam).
 *
 * Authority: D-2026-0624-103. These are the tiny PURE functions a route handler
 * uses to turn the few coarse header VALUES it already has (a referer-host
 * string, a User-Agent string) into already-derived primitives (a bare hostname,
 * a boolean bot hint) BEFORE they touch the closed schema. They map a fixed tool
 * NAME to the closed MCP operation enum.
 *
 * PRIVACY: nothing here is ever stored. `hostFromReferer` returns ONLY a bare
 * hostname (which vocab.classifyRefererHost then collapses to a closed class or
 * 'other' -- a raw host NEVER reaches the event). `isBotUa` returns a BOOLEAN; the
 * raw UA string is consumed and discarded here and is NEVER an event input/output
 * (audience is recorded as a closed class, never the UA). No URL/query/path/body.
 *
 * ASCII-only (CES Art 8.1).
 */
import type { McpTool } from './vocab';

// Fixed tool-NAME -> closed operation enum. The public MCP tools are the
// `free2aitools_*` names; the closed telemetry operation enum is the bare verb.
// Closed map: an unknown name yields null (no operation dimension smuggling).
const TOOL_OP: Record<string, McpTool> = {
  free2aitools_search: 'search',
  free2aitools_rank: 'rank',
  free2aitools_explain: 'explain',
  free2aitools_select_model: 'select_model',
  free2aitools_compare: 'compare',
};

/** mcpToolToOperation -- fixed tool name -> closed enum (or null). PURE. */
export function mcpToolToOperation(toolName: unknown): McpTool | null {
  if (typeof toolName !== 'string') return null;
  return TOOL_OP[toolName] ?? null;
}

/**
 * hostFromReferer -- parse a referer header VALUE to a BARE hostname (lowercased)
 * or null. The hostname alone is returned (NOT the path/query/scheme); the caller
 * passes it to classifyRefererHost which maps it to a closed class so the raw host
 * never reaches the event. Never throws (malformed -> null). PURE.
 */
export function hostFromReferer(referer: string | null | undefined): string | null {
  if (!referer || typeof referer !== 'string') return null;
  try {
    return new URL(referer).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

// Conservative known-crawler markers (lowercased substrings). NOT a claim of
// perfect bot filtering (SPEC: never claim that); just a coarse hint so obvious
// crawlers are not counted as external adoption. Unknown UAs stay unclassified.
const BOT_MARKERS = [
  'bot', 'crawler', 'spider', 'slurp', 'bingpreview',
  'googlebot', 'baiduspider', 'yandex', 'duckduckbot', 'facebookexternalhit',
];

/**
 * isBotUa -- coarse boolean: does the UA string look like a known crawler? The
 * raw UA is consumed here and discarded; only the BOOLEAN escapes (audience is
 * later recorded as a closed class, never the UA itself). PURE; never throws.
 */
export function isBotUa(ua: string | null | undefined): boolean {
  if (!ua || typeof ua !== 'string') return false;
  const s = ua.toLowerCase();
  return BOT_MARKERS.some((m) => s.includes(m));
}
