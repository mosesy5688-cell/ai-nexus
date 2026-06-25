import { describe, expect, it } from "vitest";
import {
  Free2AIClient,
  Free2AIError,
  Free2AINotFoundError,
  Free2AIRateLimitError,
  Free2AIRequestError,
  Free2AIUnavailableError,
} from "../src/index.js";
import { mockFetch } from "./helpers.js";

const BASE = "https://example.test";
function clientNoRetry(spec: Parameters<typeof mockFetch>[0]) {
  const { fetch } = mockFetch(spec);
  return new Free2AIClient({ baseUrl: BASE, fetch, retry: { attempts: 1 } });
}

describe("error mapping per status (never empty-success)", () => {
  it("404 -> Free2AINotFoundError (proven absence), distinct from 503", async () => {
    const c = clientNoRetry({ status: 404, body: { error: "not found" } });
    const err = await c.getEntity({ id: "ghost" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AINotFoundError);
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ error: "not found" });
    expect(err.context.path).toContain("/api/v1/entity/");
  });

  it("503 -> Free2AIUnavailableError (transient), NOT NotFound", async () => {
    const c = clientNoRetry({
      status: 503,
      headers: { "retry-after": "2" },
      body: { error: "inconclusive", resolved: [], pending: ["a"], reason: "cold" },
    });
    const err = await c.getEntity({ id: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AIUnavailableError);
    expect(err).not.toBeInstanceOf(Free2AINotFoundError);
    expect(err.retryAfterSeconds).toBe(2);
    expect((err.body as { pending: string[] }).pending).toEqual(["a"]);
  });

  it("400 -> Free2AIRequestError", async () => {
    const c = clientNoRetry({ status: 400, body: { error: "bad input" } });
    const err = await c.search({ q: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AIRequestError);
  });

  it("429 -> Free2AIRateLimitError with Retry-After", async () => {
    const c = clientNoRetry({ status: 429, headers: { "retry-after": "5" }, body: { error: "slow down" } });
    const err = await c.search({ q: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AIRateLimitError);
    expect(err.retryAfterSeconds).toBe(5);
  });

  it("concepts alternate envelope { error:true, code, message } is mapped", async () => {
    const c = clientNoRetry({
      status: 400,
      body: { error: true, code: "BAD_REQUEST", message: "invalid category", endpoint: "/concepts", timestamp: 1, _gateway_trace: "t" },
    });
    const err = await c.getConcepts({ category: "BAD" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AIRequestError);
    expect(err.message).toBe("invalid category");
  });

  it("500 -> base Free2AIError (surfaced, not collapsed)", async () => {
    const c = clientNoRetry({ status: 500, body: { error: "internal", hint: "retry later" } });
    const err = await c.search({ q: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AIError);
    expect(err.status).toBe(500);
  });

  it("network failure -> Free2AIError, never [] / null", async () => {
    const c = clientNoRetry({ throwError: new Error("ECONNRESET") });
    const err = await c.search({ q: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Free2AIError);
    expect(err.cause).toBeInstanceOf(Error);
  });
});
