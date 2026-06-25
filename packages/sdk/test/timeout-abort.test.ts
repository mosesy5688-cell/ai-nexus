import { describe, expect, it } from "vitest";
import { Free2AIClient, Free2AITimeoutError } from "../src/index.js";

const BASE = "https://example.test";

/** A fetch that never resolves until its signal aborts. */
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }
    })) as unknown as typeof fetch;
}

describe("timeout + abort", () => {
  it("times out via the client timeout -> Free2AITimeoutError", async () => {
    const c = new Free2AIClient({
      baseUrl: BASE,
      fetch: hangingFetch(),
      timeoutMs: 20,
      retry: { attempts: 1 },
    });
    const err = await c.health().catch((e) => e);
    expect(err).toBeInstanceOf(Free2AITimeoutError);
    expect(err.context.path).toBe("/api/v1/health");
  });

  it("per-call AbortSignal cancels mid-flight (not converted to empty)", async () => {
    const c = new Free2AIClient({
      baseUrl: BASE,
      fetch: hangingFetch(),
      timeoutMs: 60_000,
      retry: { attempts: 1 },
    });
    const ctrl = new AbortController();
    const p = c.search({ q: "x" }, { signal: ctrl.signal }).catch((e) => e);
    setTimeout(() => ctrl.abort(), 10);
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    // The abort must NOT yield a resolved empty result.
    expect(err).not.toHaveProperty("results");
  });

  it("client-level AbortSignal aborts the request", async () => {
    const ctrl = new AbortController();
    const c = new Free2AIClient({
      baseUrl: BASE,
      fetch: hangingFetch(),
      timeoutMs: 60_000,
      signal: ctrl.signal,
      retry: { attempts: 1 },
    });
    const p = c.health().catch((e) => e);
    setTimeout(() => ctrl.abort(), 10);
    const err = await p;
    expect(err).toBeInstanceOf(Error);
  });
});
