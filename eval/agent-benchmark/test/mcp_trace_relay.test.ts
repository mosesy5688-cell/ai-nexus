// mcp_trace_relay.test.ts — §O relay requirements (fixtures ONLY; LOCAL MOCK upstream; NO live
// agent, NO live F2AI, NO relay-to-public-endpoint). Proves: loopback-only bind, random port,
// fixed-upstream enforcement, client-upstream rejection, ALL JSON-RPC methods + notifications
// pass through, no-retry, no-cache, error + status forwarding, request/response semantic equality,
// handshake-vs-tools/call classification. Anti-vacuity (RED): relay-semantic-mutation,
// retry-insertion, handshake-misclassification.
import { describe, it, expect, afterEach } from "vitest";
import {
  createRelay, assertFrozenUpstream, classifyAutonomousUse, assertSemanticTransparency,
  isNotification, FROZEN_F2AI_UPSTREAM, type UpstreamFetch, type JsonRpcMessage, type TraceRecord, type RelayHandle,
} from "../src/mcp_trace_relay.js";

const open: RelayHandle[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

function mockUpstream(log: JsonRpcMessage[]): UpstreamFetch {
  return async (msg) => {
    log.push(msg);
    const headers = { "content-type": "application/json", "mcp-session-id": "sess-1", "mcp-protocol-version": "2025-03-26" };
    if (msg.method === "tools/call" && (msg.params as { name?: string })?.name === "fail_tool") {
      return { status: 503, headers, body: { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message: "upstream unavailable" } } };
    }
    return { status: 200, headers, body: { jsonrpc: "2.0", id: msg.id ?? null, result: { ok: true, echoMethod: msg.method } } };
  };
}
async function send(url: string, msg: JsonRpcMessage, extra: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(msg) });
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text ? (JSON.parse(text) as JsonRpcMessage) : ({} as JsonRpcMessage) };
}
async function relay(log: JsonRpcMessage[]): Promise<RelayHandle> {
  const h = await createRelay({ upstreamFetch: mockUpstream(log) });
  open.push(h);
  return h;
}

describe("transport contract: bind + upstream (§O loopback/random-port/fixed-upstream/client-reject)", () => {
  it("binds loopback-only on an OS-assigned random ephemeral port", async () => {
    const h1 = await relay([]); const h2 = await relay([]);
    expect(h1.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(h1.port).toBeGreaterThan(0);
    expect(h1.port).not.toBe(h2.port); // distinct relay per AVAILABLE episode, no shared state
  });

  it("enforces the FROZEN upstream and rejects any client-controlled upstream", async () => {
    expect(() => assertFrozenUpstream(FROZEN_F2AI_UPSTREAM)).not.toThrow();
    expect(() => assertFrozenUpstream("http://evil.example/api/mcp")).toThrow();
    await expect(createRelay({ upstreamFetch: mockUpstream([]), upstream: "http://evil.example" })).rejects.toThrow();
    const log: JsonRpcMessage[] = []; const h = await relay(log);
    const r = await send(h.url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "x-mcp-upstream": "http://evil.example" });
    expect(r.status).toBe(400);
    expect(log.length).toBe(0); // rejected before any forward
  });
});

describe("forward ALL methods + notifications; no retry/cache; error + status forwarding", () => {
  it("forwards initialize / tools/list / tools/call / UNKNOWN method / a notification unchanged", async () => {
    const log: JsonRpcMessage[] = []; const h = await relay(log);
    await send(h.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await send(h.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    await send(h.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "free2aitools_search", arguments: { query: "x" } } });
    await send(h.url, { jsonrpc: "2.0", id: 4, method: "x/custom_unknown", params: { a: 1 } });
    await send(h.url, { jsonrpc: "2.0", method: "notifications/cancelled", params: {} }); // notification: no id
    expect(log.map((m) => m.method)).toEqual(["initialize", "tools/list", "tools/call", "x/custom_unknown", "notifications/cancelled"]);
    expect(h.traces.length).toBe(5);
    expect(h.traces[4]!.is_notification).toBe(true);
    expect(h.traces.slice(0, 4).every((t) => t.is_notification === false)).toBe(true);
  });

  it("never retries or caches: two identical requests are each forwarded once", async () => {
    const log: JsonRpcMessage[] = []; const h = await relay(log);
    const msg = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "free2aitools_rank", arguments: { task: "t" } } };
    await send(h.url, msg); await send(h.url, msg);
    expect(log.length).toBe(2); // ANTI-VACUITY [retry-insertion]: a silent retry/dedup would make this != 2
  });

  it("forwards an upstream error + status verbatim, never converting it to success", async () => {
    const log: JsonRpcMessage[] = []; const h = await relay(log);
    const r = await send(h.url, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "fail_tool", arguments: {} } });
    expect(r.status).toBe(503);
    expect(r.body.error).toBeTruthy();
    expect(r.body.result).toBeUndefined();
    expect(h.traces[0]!.application_status).toBe(503);
  });
});

describe("semantic transparency (D-194 C1 — NOT byte equality)", () => {
  const req: JsonRpcMessage = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "free2aitools_explain", arguments: { canonical_id: "c1" } } };
  const upResp = { body: { jsonrpc: "2.0", id: 5, result: { entities: [{ canonical_id: "c1" }] } } as JsonRpcMessage, status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s" } };

  it("proves request/response/id/method/notification/result/error/status/header equality", () => {
    const clientResp = { ...upResp, headers: { ...upResp.headers, connection: "keep-alive" } }; // transport header may change
    const p = assertSemanticTransparency(req, { ...req }, upResp, clientResp);
    expect(p.zero_semantic_mutation).toBe(true);
    expect(isNotification(req)).toBe(false);
  });

  it("ANTI-VACUITY [relay-semantic-mutation]: a rewritten result fails the transparency proof", () => {
    const mutated = { ...upResp, body: { jsonrpc: "2.0", id: 5, result: { entities: [{ canonical_id: "TAMPERED" }] } } as JsonRpcMessage };
    const p = assertSemanticTransparency(req, { ...req }, upResp, mutated);
    expect(p.result_equal).toBe(false);
    expect(p.zero_semantic_mutation).toBe(false);
    // a mutated id / method / dropped notification likewise fails:
    const idMut = assertSemanticTransparency(req, { ...req, id: 999 }, upResp, upResp);
    expect(idMut.zero_semantic_mutation).toBe(false);
  });
});

describe("handshake vs tools/call classification (D-194 C2)", () => {
  function trace(method: string, name?: string, status = 200): TraceRecord {
    const body: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method, params: name ? { name, arguments: { query: "x" } } : {} };
    return {
      seq: 0, upstream_endpoint_identity: FROZEN_F2AI_UPSTREAM, is_notification: false, method,
      request_id: 1, tool_name: method === "tools/call" ? name ?? null : null, arguments: name ? { query: "x" } : undefined,
      response_result: status < 300 ? { ok: true } : null, response_error: status < 300 ? null : { code: -1 },
      application_status: status, request_body: body, response_body: {}, started_ms: 0, ended_ms: 1,
    };
  }
  it("initialize + tools/list are NEVER autonomous use; only a frozen-F2AI tools/call is", () => {
    // ANTI-VACUITY [handshake-misclassification]: discovery counted as use would be a false positive.
    expect(classifyAutonomousUse(trace("initialize")).is_autonomous_use).toBe(false);
    expect(classifyAutonomousUse(trace("tools/list")).is_autonomous_use).toBe(false);
    expect(classifyAutonomousUse(trace("ping")).is_autonomous_use).toBe(false);
    const nonF2ai = classifyAutonomousUse(trace("tools/call", "web_search"));
    expect(nonF2ai.is_autonomous_use).toBe(false);
    const use = classifyAutonomousUse(trace("tools/call", "free2aitools_search"), true);
    expect(use.is_autonomous_use).toBe(true);
    expect(use.selection_occurred).toBe(true);
    expect(use.arguments_valid).toBe(true);
    expect(use.upstream_success).toBe(true);
    expect(use.result_reached_agent).toBe(true);
    expect(use.result_used).toBe(true);
    // an upstream-failed F2AI call is still "selection occurred" but not result-reached.
    const failed = classifyAutonomousUse(trace("tools/call", "free2aitools_rank", 503));
    expect(failed.selection_occurred).toBe(true);
    expect(failed.result_reached_agent).toBe(false);
  });
});
