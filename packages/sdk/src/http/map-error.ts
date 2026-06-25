/**
 * Map a non-OK HTTP response to a typed Free2AIError subclass.
 *
 * HARD RULE: never returns []/null/success — always throws a typed error that
 * preserves status + Retry-After + service body + context. 404 and 503 stay
 * DISTINCT (NotFound vs Unavailable). Handles BOTH error envelopes:
 *   - standard:  { error: string }
 *   - concepts:  { error: true, code, message, ... }
 *   - compare503:{ error, resolved, pending, reason }
 *   - select500: { error, detail?, hint? }
 */
import {
  Free2AIError,
  Free2AINotFoundError,
  Free2AIRateLimitError,
  Free2AIRequestError,
  Free2AIUnavailableError,
  type RequestContext,
} from "../errors.js";
import { parseRetryAfter } from "./retry.js";

/** Extract a human message from any of the known error envelopes. */
export function extractMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    // concepts alternate envelope: { error: true, code, message }
    if (b.error === true && typeof b.message === "string") {
      return b.message;
    }
    // standard envelope: { error: "<message>" }
    if (typeof b.error === "string") {
      return b.error;
    }
    if (typeof b.message === "string") return b.message;
  }
  return `HTTP ${status}`;
}

/** Build the typed error for a non-OK response. Never swallows the signal. */
export function mapHttpError(
  status: number,
  body: unknown,
  headers: Headers,
  context: RequestContext,
): Free2AIError {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"));
  const retryAfterSeconds =
    retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000);
  const message = extractMessage(body, status);
  const opts = { status, retryAfterSeconds, body, context } as const;

  if (status === 404) return new Free2AINotFoundError(message, opts);
  if (status === 429) return new Free2AIRateLimitError(message, opts);
  if (status === 503) return new Free2AIUnavailableError(message, opts);
  if (status === 400) return new Free2AIRequestError(message, opts);
  // 500 and any other non-OK: surfaced as the base error (not retried by default).
  return new Free2AIError(message, opts);
}
