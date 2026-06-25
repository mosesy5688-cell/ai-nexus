/** Test helpers: a controllable mock fetch that records calls. */
export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

export interface MockResponseSpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** If set, the mock throws this (simulates a network error). */
  throwError?: Error;
}

/**
 * Build a mock fetch that returns the given spec(s) in order. The LAST spec is
 * reused for any further calls (useful for "always 503" retry tests).
 */
export function mockFetch(
  specs: MockResponseSpec | MockResponseSpec[],
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const list = Array.isArray(specs) ? specs : [specs];
  const calls: RecordedCall[] = [];
  let i = 0;
  const fn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    const spec = list[Math.min(i, list.length - 1)] ?? {};
    i++;
    if (init?.signal?.aborted) {
      throw makeAbortError(init.signal.reason);
    }
    if (spec.throwError) throw spec.throwError;
    const status = spec.status ?? 200;
    const headers = new Headers(spec.headers ?? {});
    const text = spec.body === undefined ? "" : JSON.stringify(spec.body);
    return new Response(text, { status, headers });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

function makeAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
