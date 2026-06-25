/**
 * Retry classification + backoff for the SDK.
 *
 * SAFE retry is restricted to IDEMPOTENT GET (Section 5). POST /select is
 * NEVER auto-retried, even on 503. Retryable signals: network error / 429 /
 * 503 / transient 5xx. NON-retryable: 400, 404. Retry-After is respected.
 * Attempts are finite and abortable.
 */

export interface RetryOptions {
  /** Total attempts (initial + retries). <= 1 disables retry. */
  attempts: number;
  /** Base backoff in ms for exponential backoff when no Retry-After is given. */
  baseDelayMs: number;
  /** Ceiling for any single backoff wait in ms. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  attempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 8000,
};

/** Statuses that are retryable for an idempotent GET. 500 is NOT (surface it). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Parse a Retry-After header (delta-seconds OR HTTP-date) into ms, or null. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Compute the delay before the next attempt. Honors Retry-After when present;
 * otherwise exponential backoff with full jitter, capped at maxDelayMs.
 */
export function computeDelayMs(
  attemptIndex: number,
  retryAfterMs: number | null,
  opts: RetryOptions,
): number {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, opts.maxDelayMs);
  }
  const exp = opts.baseDelayMs * 2 ** attemptIndex;
  const capped = Math.min(exp, opts.maxDelayMs);
  // Full jitter in [0, capped].
  return Math.floor(Math.random() * capped);
}

/** Abortable sleep that rejects if the signal fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
