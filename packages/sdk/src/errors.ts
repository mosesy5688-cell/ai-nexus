/**
 * Error model for the Free2AITools SDK.
 *
 * HONEST-CONTRACT (Section 5, HARD RULE): a 429 / 503 / network failure / 404
 * is NEVER converted into [] / null / { success: true } / empty results. It is
 * surfaced as a typed error that preserves:
 *   - HTTP status
 *   - Retry-After (when present)
 *   - the service error body (resolved/pending/reason for compare; detail/hint
 *     for select; concepts' alternate envelope)
 *   - the original cause
 *   - request context (method + path + sanitized params)
 *
 * 404 == proven absence (Free2AINotFoundError); 503 == transient
 * (Free2AIUnavailableError, retryable for idempotent GET). These are NEVER
 * collapsed into one another.
 *
 * SECURITY: errors NEVER log/serialize sensitive request bodies or secrets.
 * The API is unauthenticated (no keys), but the rule holds: request context
 * carries only method + path + a SANITIZED param snapshot.
 */

/** Method + path + sanitized params — safe to attach to every error. */
export interface RequestContext {
  method: string;
  path: string;
  /** Sanitized: only param names/primitive values used to build the request. */
  params?: Record<string, unknown>;
}

export interface Free2AIErrorOptions {
  status?: number | null;
  retryAfterSeconds?: number | null;
  /** The parsed service error body (NOT sensitive — no auth in this API). */
  body?: unknown;
  cause?: unknown;
  context?: RequestContext;
}

/** Base class for every error the SDK throws. */
export class Free2AIError extends Error {
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly body: unknown;
  override readonly cause: unknown;
  readonly context: RequestContext | undefined;

  constructor(message: string, opts: Free2AIErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.body = opts.body;
    this.cause = opts.cause;
    this.context = opts.context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 400 — bad request from the SERVER (invalid params per the schema). No retry. */
export class Free2AIRequestError extends Free2AIError {}

/**
 * Client-side validation failure (e.g. missing q, ids out of range). The
 * request was NOT sent. No status. Distinct from a server 400.
 */
export class Free2AIValidationError extends Free2AIError {}

/** 429 — rate limited. Retryable for idempotent GET, respecting Retry-After. */
export class Free2AIRateLimitError extends Free2AIError {}

/** 503 — transient / inconclusive. Retryable for idempotent GET. NOT absence. */
export class Free2AIUnavailableError extends Free2AIError {}

/** 404 — proven absence. NEVER retried. NEVER collapsed into null-success. */
export class Free2AINotFoundError extends Free2AIError {}

/** The request (or a retry) timed out / was aborted by the timeout controller. */
export class Free2AITimeoutError extends Free2AIError {}
