import { describe, expect, it } from "vitest";
import {
  Free2AIClient,
  Free2AINotFoundError,
  Free2AIRequestError,
  Free2AIUnavailableError,
} from "../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "https://example.test";
const FAST_RETRY = { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 };

describe("retry eligibility (SAFE = idempotent GET only)", () => {
  it("GET 503 is retried then succeeds", async () => {
    const { fetch, calls } = mockFetch([
      { status: 503, headers: { "retry-after": "0" }, body: { error: "cold" } },
      { status: 200, body: { results: [], total_count: 0 } },
    ]);
    const c = new Free2AIClient({ baseUrl: BASE, fetch, retry: FAST_RETRY });
    const res = await c.search({ q: "x" });
    expect(res.total_count).toBe(0);
    expect(calls.length).toBe(2);
  });

  it("GET 503 exhausts attempts -> typed Unavailable (never empty success)", async () => {
    const { fetch, calls } = mockFetch({ status: 503, headers: { "retry-after": "0" }, body: { error: "cold" } });
    const c = new Free2AIClient({ baseUrl: BASE, fetch, retry: FAST_RETRY });
    const err = await c.search({ q: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AIUnavailableError);
    expect(calls.length).toBe(3);
  });

  it("GET 404 is NOT retried", async () => {
    const { fetch, calls } = mockFetch({ status: 404, body: { error: "absent" } });
    const c = new Free2AIClient({ baseUrl: BASE, fetch, retry: FAST_RETRY });
    const err = await c.getEntity({ id: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AINotFoundError);
    expect(calls.length).toBe(1);
  });

  it("GET 400 is NOT retried", async () => {
    const { fetch, calls } = mockFetch({ status: 400, body: { error: "bad" } });
    const c = new Free2AIClient({ baseUrl: BASE, fetch, retry: FAST_RETRY });
    const err = await c.search({ q: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AIRequestError);
    expect(calls.length).toBe(1);
  });

  it("POST select is NOT auto-retried even on 503", async () => {
    const { fetch, calls } = mockFetch({ status: 503, headers: { "retry-after": "0" }, body: { error: "rankings unavailable" } });
    const c = new Free2AIClient({ baseUrl: BASE, fetch, retry: FAST_RETRY });
    const err = await c.select({ task: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AIUnavailableError);
    expect(calls.length).toBe(1);
  });

  it("network blip on GET is retried", async () => {
    const { fetch, calls } = mockFetch([
      { throwError: new Error("ECONNRESET") },
      { status: 200, body: { results: [] } },
    ]);
    const c = new Free2AIClient({ baseUrl: BASE, fetch, retry: FAST_RETRY });
    await c.search({ q: "x" });
    expect(calls.length).toBe(2);
  });

  it("retry can be disabled (attempts=1)", async () => {
    const { fetch, calls } = mockFetch({ status: 503, body: { error: "cold" } });
    const c = new Free2AIClient({ baseUrl: BASE, fetch, retry: { attempts: 1 } });
    await c.search({ q: "x" }).catch(() => {});
    expect(calls.length).toBe(1);
  });
});
