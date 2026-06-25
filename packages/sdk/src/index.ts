/**
 * @free2aitools/sdk (PACKAGE NAME CANDIDATE — npm name + org ownership NOT yet
 * verified; package is `private` for now).
 *
 * A free, public TypeScript SDK for the Free2AITools AI discovery / evidence /
 * identity REST API (https://free2aitools.com). Unauthenticated, no telemetry,
 * no analytics, no ads. Standard Web APIs only (fetch/AbortController/URL).
 *
 * CALLER-FINAL-DECISION: the SDK retrieves candidates, evidence, and FNI
 * rankings. It does NOT assert "best", guarantee compatibility, or make the
 * final choice for you. FREE is not unlimited: the public API may emit honest
 * 503 (transient) responses, surfaced as typed errors, never as empty success.
 */
export { Free2AIClient } from "./client.js";
export {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  type Free2AIClientOptions,
  type CallOptions,
} from "./config.js";

// Convenience helpers also usable standalone.
export { getEntityEvidence, type EntityEvidence } from "./methods/evidence.js";
export { badgeUrl } from "./methods/badge.js";

// Error model.
export {
  Free2AIError,
  Free2AIRequestError,
  Free2AIValidationError,
  Free2AIRateLimitError,
  Free2AIUnavailableError,
  Free2AINotFoundError,
  Free2AITimeoutError,
  type RequestContext,
  type Free2AIErrorOptions,
} from "./errors.js";

// Retry policy type (for advanced configuration).
export { type RetryOptions, DEFAULT_RETRY } from "./http/retry.js";

// All request + response + common types.
export * from "./types/index.js";
