/** Query-string and URL construction helpers (standard Web APIs only). */

/** A primitive that can be serialized into a query param. */
export type QueryValue = string | number | boolean | undefined | null;

/**
 * Build a URLSearchParams from a record, dropping undefined/null entries.
 * Booleans and numbers are stringified; arrays are NOT auto-joined here
 * (callers pass already-joined CSV strings, matching the REST wire form).
 */
export function buildQuery(params: Record<string, QueryValue>): URLSearchParams {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    usp.set(key, String(value));
  }
  return usp;
}

/** Join a base URL, a path, and an optional query into a single URL string. */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: URLSearchParams,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const rel = path.startsWith("/") ? path : `/${path}`;
  const qs = query ? query.toString() : "";
  return qs ? `${base}${rel}?${qs}` : `${base}${rel}`;
}

/**
 * Sanitize params for error context: keep only param names and primitive
 * values. Never carries request bodies or secrets (this API is unauthenticated).
 */
export function sanitizeParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    } else {
      // Non-primitive (e.g. a constraints object): record presence only.
      out[k] = "[object]";
    }
  }
  return out;
}
