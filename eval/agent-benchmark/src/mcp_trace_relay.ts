// mcp_trace_relay.ts — P6 transparent local-loopback MCP trace relay (D-193 §J).
// TRANSPORT + TRACE ONLY. Forwards JSON-RPC to the FROZEN public F2AI endpoint and records
// every message. D-194 C1 = MCP_JSONRPC_SEMANTIC_TRANSPARENCY (NOT byte equality): transport
// framing MAY change; method/id/params/result/error/notification semantics MUST NOT. Never
// claims byte equality. AVAILABLE-arm only. No add/remove/rewrite/inject/cache/retry/filter.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Compile-time/frozen upstream. Client may NEVER redirect this (rule: reject client upstream).
export const FROZEN_F2AI_UPSTREAM = "https://free2aitools.com/api/mcp";

export const F2AI_TOOL_NAMES = [
  "free2aitools_search", "free2aitools_rank", "free2aitools_explain",
  "free2aitools_select_model", "free2aitools_compare",
] as const;
const F2AI_SET = new Set<string>(F2AI_TOOL_NAMES);

// MCP discovery / protocol-management. D-194 C2: NEVER autonomous use; cannot satisfy
// RARR or violate CNU. Only a tools/call for a frozen F2AI tool enters use-classification.
export const MCP_DISCOVERY_METHODS = new Set([
  "initialize", "notifications/initialized", "ping", "tools/list",
  "resources/list", "prompts/list", "logging/setLevel",
]);

// Hop-by-hop + framing headers the relay MAY alter without semantic change (C1).
export const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "host", "content-encoding", "accept-encoding",
]);

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}
export interface UpstreamResponse { status: number; headers: Record<string, string>; body: unknown; }
export type UpstreamFetch = (msg: JsonRpcMessage, headers: Record<string, string>) => Promise<UpstreamResponse>;

export interface TraceRecord {
  seq: number;
  upstream_endpoint_identity: string;
  is_notification: boolean;
  method: string | null;
  request_id: string | number | null;
  tool_name: string | null;
  arguments: unknown;
  response_result: unknown;
  response_error: unknown;
  application_status: number;
  request_body: JsonRpcMessage;
  response_body: unknown;
  started_ms: number;
  ended_ms: number;
}

// A notification = a request with a method but NO id (JSON-RPC 2.0).
export function isNotification(m: JsonRpcMessage): boolean {
  return m.method !== undefined && (m.id === undefined || m.id === null);
}
export function isToolsCall(m: JsonRpcMessage): boolean { return m.method === "tools/call"; }
export function isDiscovery(method: string | null | undefined): boolean {
  return method != null && MCP_DISCOVERY_METHODS.has(method);
}
function toolNameOf(m: JsonRpcMessage): string | null {
  const p = isToolsCall(m) ? (m.params as { name?: unknown } | undefined) : undefined;
  return typeof p?.name === "string" ? p.name : null;
}
function argsOf(m: JsonRpcMessage): unknown {
  return isToolsCall(m) ? (m.params as { arguments?: unknown } | undefined)?.arguments : undefined;
}

// Reject any client attempt to redirect upstream; the endpoint is frozen at compile time.
export function assertFrozenUpstream(requested: string | undefined | null): void {
  if (requested != null && requested !== FROZEN_F2AI_UPSTREAM) {
    throw new Error(`RELAY_REJECT_CLIENT_UPSTREAM: ${requested}`);
  }
}

export function transportNormalizeHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk) || v === undefined) continue;
    out[lk] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

export interface RelayHandle { url: string; port: number; traces: TraceRecord[]; close: () => Promise<void>; }

// One relay per AVAILABLE episode. Binds 127.0.0.1 on an OS-assigned ephemeral port
// (listen(0) => kernel picks a free port; no collision). Stateless across episodes:
// each createRelay() owns its own traces array and HTTP server (no shared session/log).
// upstreamFetch is injected so tests use a LOCAL MOCK upstream — never a live request.
export async function createRelay(opts: { upstreamFetch: UpstreamFetch; upstream?: string }): Promise<RelayHandle> {
  assertFrozenUpstream(opts.upstream);
  const upstream = opts.upstream ?? FROZEN_F2AI_UPSTREAM;
  const traces: TraceRecord[] = [];
  let seq = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clientUpstream = req.headers["x-mcp-upstream"];
    try {
      assertFrozenUpstream(typeof clientUpstream === "string" ? clientUpstream : undefined);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "client-controlled upstream rejected" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as JsonRpcMessage;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "malformed json-rpc" }));
      return;
    }
    const started = Date.now();
    // Forward EVERY method + notification unchanged. No 3-method allowlist, no retry,
    // no cache, no dedup, no schema-normalization, no tool-filtering, no fallback.
    const up = await opts.upstreamFetch(msg, transportNormalizeHeaders(req.headers));
    const ended = Date.now();
    const body = up.body as JsonRpcMessage | string;
    traces.push({
      seq: seq++,
      upstream_endpoint_identity: upstream,
      is_notification: isNotification(msg),
      method: msg.method ?? null,
      request_id: msg.id ?? null,
      tool_name: toolNameOf(msg),
      arguments: argsOf(msg),
      response_result: typeof body === "object" ? body?.result : undefined,
      response_error: typeof body === "object" ? body?.error : undefined,
      application_status: up.status,
      request_body: msg,
      response_body: up.body,
      started_ms: started,
      ended_ms: ended,
    });
    const outHeaders = transportNormalizeHeaders(up.headers);
    outHeaders["content-type"] = outHeaders["content-type"] ?? "application/json";
    // Forward upstream status/result/error verbatim — never convert an error to success.
    res.writeHead(up.status, outHeaders);
    res.end(typeof up.body === "string" ? up.body : JSON.stringify(up.body));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "relay forward failure" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("relay bind failed (no loopback address)");
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    port: addr.port,
    traces,
    // Deterministic close + flush at episode completion/timeout.
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export interface AutonomousUse {
  is_autonomous_use: boolean;
  reason: string;
  selected_tool: string | null;
  selection_occurred: boolean;
  arguments_valid: boolean;
  upstream_success: boolean;
  result_reached_agent: boolean;
  result_used: boolean;
}

// D-194 C2: per tools/call record. Discovery/protocol => NEVER autonomous use.
export function classifyAutonomousUse(t: TraceRecord, resultUsed = false): AutonomousUse {
  if (t.method == null || isDiscovery(t.method) || !isToolsCall(t.request_body)) {
    return {
      is_autonomous_use: false, reason: "MCP_DISCOVERY_OR_PROTOCOL_NEVER_USE", selected_tool: null,
      selection_occurred: false, arguments_valid: false, upstream_success: false,
      result_reached_agent: false, result_used: false,
    };
  }
  const tool = t.tool_name;
  const isF2ai = tool != null && F2AI_SET.has(tool);
  const argsValid = isF2ai && t.arguments != null && typeof t.arguments === "object";
  const upstreamOk = t.application_status >= 200 && t.application_status < 300 && t.response_error == null;
  const reached = upstreamOk && t.response_result != null;
  return {
    is_autonomous_use: isF2ai,
    reason: isF2ai ? "TOOLS_CALL_FROZEN_F2AI_TOOL" : "TOOLS_CALL_NON_F2AI_TOOL",
    selected_tool: tool,
    selection_occurred: isF2ai,
    arguments_valid: Boolean(argsValid),
    upstream_success: upstreamOk,
    result_reached_agent: reached,
    result_used: reached && resultUsed,
  };
}

function canon(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}

export interface TransparencyProof {
  request_body_equal: boolean;
  id_equal: boolean;
  method_equal: boolean;
  notification_preserved: boolean;
  result_equal: boolean;
  error_equal: boolean;
  status_preserved: boolean;
  mcp_headers_preserved: boolean;
  zero_semantic_mutation: boolean;
}

// Proves transparency AFTER documented transport normalization (C1). Compares the
// client-visible request/response against the upstream request/response. NOT byte equality.
export function assertSemanticTransparency(
  clientReq: JsonRpcMessage,
  upstreamReq: JsonRpcMessage,
  upstreamResp: { body: JsonRpcMessage; status: number; headers: Record<string, string> },
  clientResp: { body: JsonRpcMessage; status: number; headers: Record<string, string> },
  mcpHeaderKeys: string[] = ["mcp-session-id", "mcp-protocol-version", "content-type"],
): TransparencyProof {
  const p: TransparencyProof = {
    request_body_equal: canon(clientReq) === canon(upstreamReq),
    id_equal: canon(clientReq.id ?? null) === canon(upstreamReq.id ?? null),
    method_equal: (clientReq.method ?? null) === (upstreamReq.method ?? null),
    notification_preserved: isNotification(clientReq) === isNotification(upstreamReq),
    result_equal: canon(upstreamResp.body.result) === canon(clientResp.body.result),
    error_equal: canon(upstreamResp.body.error) === canon(clientResp.body.error),
    status_preserved: upstreamResp.status === clientResp.status,
    mcp_headers_preserved: mcpHeaderKeys.every((k) => upstreamResp.headers[k] === clientResp.headers[k]),
    zero_semantic_mutation: false,
  };
  p.zero_semantic_mutation =
    p.request_body_equal && p.id_equal && p.method_equal && p.notification_preserved &&
    p.result_equal && p.error_equal && p.status_preserved && p.mcp_headers_preserved;
  return p;
}
