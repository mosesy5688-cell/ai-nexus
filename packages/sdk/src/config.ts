/** Client configuration + defaults. */
import { DEFAULT_RETRY, type RetryOptions } from "./http/retry.js";

/** Sensible default base URL = production. Always overridable (Q1). */
export const DEFAULT_BASE_URL = "https://free2aitools.com";

/** Default per-request timeout (Q7): 30s, under the CF worker ceiling. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface Free2AIClientOptions {
  /** Defaults to https://free2aitools.com. */
  baseUrl?: string;
  /** Injectable fetch (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Client-level AbortSignal, merged with per-call signals. */
  signal?: AbortSignal;
  /** Retry policy for idempotent GET. Set attempts<=1 to disable. */
  retry?: Partial<RetryOptions>;
}

export interface ResolvedConfig {
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  retry: RetryOptions;
}

export function resolveConfig(opts: Free2AIClientOptions = {}): ResolvedConfig {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "No fetch implementation available. Pass options.fetch or run on a platform with a global fetch (Node 20+, Workers, browsers).",
    );
  }
  return {
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
    fetchImpl,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
    retry: { ...DEFAULT_RETRY, ...(opts.retry ?? {}) },
  };
}

/** Per-call options shared by every method. */
export interface CallOptions {
  /** Per-call AbortSignal (merged with the client-level signal). */
  signal?: AbortSignal;
}
