import { describe, expect, it } from "vitest";
import { Free2AIClient, Free2AIValidationError } from "../src/index.js";
import { mockFetch } from "./helpers.js";

function client() {
  const { fetch, calls } = mockFetch({ body: {} });
  return { c: new Free2AIClient({ baseUrl: "https://example.test", fetch }), calls };
}

describe("client-side validation (no request sent)", () => {
  it("search rejects empty q before any fetch", async () => {
    const { c, calls } = client();
    await expect(c.search({ q: "" })).rejects.toBeInstanceOf(Free2AIValidationError);
    expect(calls.length).toBe(0);
  });

  it("getEntity rejects missing id", async () => {
    const { c, calls } = client();
    // @ts-expect-error intentional bad input
    await expect(c.getEntity({})).rejects.toBeInstanceOf(Free2AIValidationError);
    expect(calls.length).toBe(0);
  });

  it("compare requires 2..25 ids", async () => {
    const { c } = client();
    await expect(c.compare({ ids: ["only-one"] })).rejects.toBeInstanceOf(
      Free2AIValidationError,
    );
    const tooMany = Array.from({ length: 26 }, (_, i) => `id${i}`);
    await expect(c.compare({ ids: tooMany })).rejects.toBeInstanceOf(
      Free2AIValidationError,
    );
  });

  it("trends requires 1..25 ids", async () => {
    const { c } = client();
    await expect(c.getTrendsBatch({ ids: [] })).rejects.toBeInstanceOf(
      Free2AIValidationError,
    );
  });

  it("select rejects empty task", async () => {
    const { c, calls } = client();
    await expect(c.select({ task: "  " })).rejects.toBeInstanceOf(
      Free2AIValidationError,
    );
    expect(calls.length).toBe(0);
  });

  it("concepts rejects negative offset", async () => {
    const { c } = client();
    await expect(c.getConcepts({ offset: -1 })).rejects.toBeInstanceOf(
      Free2AIValidationError,
    );
  });
});
