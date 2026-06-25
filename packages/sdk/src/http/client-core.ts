/**
 * The HTTP transport core: timeout + abort + finite retry, standard Web APIs
 * only (fetch, AbortController, URL, URLSearchParams). Injectable fetch.
 *
 * Retry is applied ONLY when the caller marks a request idempotent (GET). POST
 * (select) passes idempotent=false => no auto-retry even on 503.
 */
import {
  Free2AIError,
  Free2AITimeoutError,
  type RequestContext,
} from "../errors.js";
import {
  DEFAULT_RETRY,
  type RetryOptions,
  computeDelayMs,
  isRetryableStatus,
  parseRetryAfter,
  sleep,
} from "./retry.js";
import { mapHttpError } from "./map-error.js";

export type FetchLike = typeof fetch;

export interface CoreConfig {
  fetchImpl: FetchLike;
  timeoutMs: number;
  retry: RetryOptions;
  /** Client-level signal; merged with per-call signal. */
  signal?: AbortSignal | undefined;
}

export interface CoreRequest {
  method: "GET" | "POST";
  url: string;
  /** Whether SAFE retry may apply (true only for idempotent GET). */
  idempotent: boolean;
  body?: unknown;
  context: RequestContext;
  /** Per-call signal (merged with client + timeout signals). */
  signal?: AbortSignal | undefined;
}

/** Merge multiple AbortSignals into one (AbortSignal.any when available). */
function mergeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const real = signals.filter((s): s is AbortSignal => !!s);
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn(real);
  // Fallback: chain via a controller.
  const ctrl = new AbortController();
  for (const s of real) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Perform one fetch attempt with its own timeout controller. */
async function attempt(
  req: CoreRequest,
  cfg: CoreConfig,
): Promise<Response> {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(new Error("timeout")), cfg.timeoutMs);
  const signal = mergeSignals([cfg.signal, req.signal, timeoutCtrl.signal]);
  const init: RequestInit = { method: req.method, signal };
  if (req.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(req.body);
  }
  try {
    return await cfg.fetchImpl(req.url, init);
  } catch (err) {
    if (timeoutCtrl.signal.aborted && !(req.signal?.aborted || cfg.signal?.aborted)) {
      throw new Free2AITimeoutError(`Request timed out after ${cfg.timeoutMs}ms`, {
        cause: err,
        context: req.context,
      });
    }
    throw err; // network error / external abort -> handled by caller loop
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a request with retry/timeout/abort and return the parsed JSON body.
 * On any non-OK status this throws a typed error (never null/empty success).
 */
export async function execute<T>(req: CoreRequest, cfg: CoreConfig): Promise<T> {
  const maxAttempts = req.idempotent ? Math.max(1, cfg.retry.attempts) : 1;
  let lastError: unknown;

  for (let i = 0; i < maxAttempts; i++) {
    let res: Response;
    try {
      res = await attempt(req, cfg);
    } catch (err) {
      // Timeout and external aborts are terminal — do not retry.
      if (err instanceof Free2AITimeoutError) throw err;
      if (isExternalAbort(err, cfg, req)) throw err;
      lastError = err; // network blip
      if (req.idempotent && i < maxAttempts - 1) {
        await sleep(computeDelayMs(i, null, cfg.retry), externalSignal(cfg, req));
        continue;
      }
      throw new Free2AIError("Network request failed", {
        cause: err,
        context: req.context,
      });
    }

    if (res.ok) {
      return (await parseBody(res)) as T;
    }

    const body = await parseBody(res);
    const typed = mapHttpError(res.status, body, res.headers, req.context);
    const retryable = req.idempotent && isRetryableStatus(res.status);
    if (retryable && i < maxAttempts - 1) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      await sleep(computeDelayMs(i, retryAfterMs, cfg.retry), externalSignal(cfg, req));
      lastError = typed;
      continue;
    }
    throw typed;
  }
  // Exhausted retries on a retryable signal — surface the last typed error.
  throw lastError instanceof Free2AIError
    ? lastError
    : new Free2AIError("Request failed after retries", {
        cause: lastError,
        context: req.context,
      });
}

function externalSignal(cfg: CoreConfig, req: CoreRequest): AbortSignal | undefined {
  return req.signal ?? cfg.signal;
}

function isExternalAbort(err: unknown, cfg: CoreConfig, req: CoreRequest): boolean {
  return (
    (cfg.signal?.aborted || req.signal?.aborted) === true &&
    err instanceof Error &&
    (err.name === "AbortError" || err.message === "aborted")
  );
}

export { DEFAULT_RETRY };
