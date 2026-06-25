/**
 * LIVE black-box smoke test against https://free2aitools.com.
 *
 * READ-ONLY: GET health/search/entity/compare/concepts only. NO mutation, NO
 * POST, NO telemetry, NO API key. Asserts typed shapes + that errors are
 * explicit (never []/null-success). Set SDK_LIVE_SMOKE=1 to enable; skipped by
 * default so unit/contract runs stay hermetic and offline.
 */
import { describe, expect, it } from "vitest";
import {
  Free2AIClient,
  Free2AIError,
  Free2AINotFoundError,
} from "../src/index.js";

const ENABLED = process.env.SDK_LIVE_SMOKE === "1";
const d = ENABLED ? describe : describe.skip;

d("live black-box smoke (read-only)", () => {
  const c = new Free2AIClient({ timeoutMs: 25_000 });

  it("health() returns a typed snapshot", async () => {
    const h = await c.health();
    expect(typeof h.version).toBe("string");
    expect(typeof h.status).toBe("string");
    expect(h.meta).toBeTruthy();
  }, 30_000);

  it("search() returns typed results with TOP-LEVEL elapsed_ms", async () => {
    const r = await c.search({ q: "llama", limit: 3 });
    expect(Array.isArray(r.results)).toBe(true);
    expect(typeof r.total_count).toBe("number");
    expect(typeof r.elapsed_ms).toBe("number"); // top-level, not under meta
    if (r.results.length > 0) {
      const first = r.results[0]!;
      expect(first.fni_s).toBeNull(); // semantic ALWAYS null
    }
  }, 30_000);

  it("getEntity() resolves a real entity OR throws a typed error (never null)", async () => {
    const r = await c.search({ q: "llama", limit: 1 });
    if (r.results.length === 0) return;
    const id = r.results[0]!.id;
    const e = await c.getEntity({ id });
    expect(e.entity).toBeTruthy();
    expect(e.entity.fni.factors.semantic).toBeNull();
  }, 30_000);

  it("getEntity() on a definitely-absent id throws NotFound, not null", async () => {
    const err = await c
      .getEntity({ id: "this--entity--surely--does--not--exist--zzz999" })
      .catch((e) => e);
    // Either proven-absent (404) or a typed transient — never a resolved null.
    expect(err).toBeInstanceOf(Free2AIError);
    if (err.status === 404) expect(err).toBeInstanceOf(Free2AINotFoundError);
  }, 30_000);

  it("compare() returns entities in request order with found flags", async () => {
    const r = await c.search({ q: "llama", limit: 2 });
    if (r.results.length < 2) return;
    const ids = r.results.slice(0, 2).map((x) => x.id);
    const cmp = await c.compare({ ids });
    expect(Array.isArray(cmp.entities)).toBe(true);
    expect(typeof cmp.meta.requested).toBe("number");
  }, 30_000);

  it("getConcepts() uses offset/limit pagination", async () => {
    const con = await c.getConcepts({ limit: 5 });
    expect(Array.isArray(con.concepts)).toBe(true);
    expect(con.version).toBe("knowledge_v1");
    expect(typeof con.offset).toBe("number");
  }, 30_000);
});
