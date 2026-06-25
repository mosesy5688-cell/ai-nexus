/**
 * Examples 5-6: timeout + abort, and explicit error handling across the typed
 * error hierarchy. The honest-contract rule: a 404/503/network failure is NEVER
 * turned into an empty/null/success — it is always a typed error you handle.
 */
import {
  Free2AIClient,
  Free2AIError,
  Free2AINotFoundError,
  Free2AIRateLimitError,
  Free2AITimeoutError,
  Free2AIUnavailableError,
  Free2AIValidationError,
} from "../src/index.js";

const client = new Free2AIClient({ timeoutMs: 10_000 });

// (5) Timeout + abort.
export async function timeoutAndAbort(): Promise<void> {
  const controller = new AbortController();
  // Abort after 2s regardless of the 10s client timeout.
  const t = setTimeout(() => controller.abort(), 2_000);
  try {
    await client.search({ q: "long running query" }, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Free2AITimeoutError) console.log("timed out:", err.message);
    else console.log("aborted or failed:", (err as Error).message);
  } finally {
    clearTimeout(t);
  }
}

// (6) Explicit error handling for the full hierarchy.
export async function handleErrors(id: string): Promise<void> {
  try {
    const e = await client.getEntity({ id });
    console.log("resolved:", e.entity.name);
  } catch (err) {
    if (err instanceof Free2AIValidationError) {
      console.log("bad input (not sent):", err.message);
    } else if (err instanceof Free2AINotFoundError) {
      console.log("PROVEN ABSENT (404) — do not retry:", err.status);
    } else if (err instanceof Free2AIUnavailableError) {
      console.log("TRANSIENT (503) — retry after:", err.retryAfterSeconds, "s");
    } else if (err instanceof Free2AIRateLimitError) {
      console.log("rate limited (429) — back off:", err.retryAfterSeconds);
    } else if (err instanceof Free2AITimeoutError) {
      console.log("timed out");
    } else if (err instanceof Free2AIError) {
      console.log("other API error:", err.status, err.message);
    } else {
      throw err; // truly unexpected
    }
  }
}
