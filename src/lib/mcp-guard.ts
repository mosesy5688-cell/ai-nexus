/**
 * MCP request/argument size guard (Founder D-178 §D / D-182, B2).
 *
 * Application-layer fail-closed guard for the MCP JSON-RPC route. It rejects
 * oversized / over-deep / over-count / oversized-constraints requests BEFORE
 * JSON.parse and BEFORE any search/VFS/R2/DB dispatch. Two strictly-ordered
 * gates, both authoritative regardless of transfer encoding:
 *
 *   G1 PRE-PARSE BYTE GATE   — readBoundedBody(): a Content-Length FAST-REJECT
 *      hint plus an authoritative bounded ReadableStream read that counts RAW
 *      chunk byteLength (Uint8Array), cancels the stream the moment the running
 *      total exceeds MAX_REQUEST_BYTES, and decodes (TextDecoder) only AFTER the
 *      byte ceiling has passed. The decoded JS string length is NEVER used as a
 *      size measure.
 *   G2 POST-PARSE STRUCTURAL GATE — validateRpcShape(): bounded nesting-depth +
 *      per-field string-length + array-count + constraints (keys / UTF-8 bytes /
 *      scalar-only) checks on the parsed object, returned BEFORE method/tool
 *      dispatch.
 *
 * Pure + dependency-free + unit-testable in isolation. The offending CONTENT is
 * NEVER echoed back. In-spec requests are unaffected (every cap sits far above
 * the largest documented legitimate call).
 */

// --- Limits (exact, D-178 §D) -------------------------------------------------
export const MAX_REQUEST_BYTES = 65536;     // 64 KiB total raw body bytes
export const MAX_NESTING_DEPTH = 8;         // parsed-object container depth
export const MAX_QUERY_CHARS = 2048;        // args.query string length
export const MAX_TASK_CHARS = 2048;         // args.task string length
export const MAX_ID_CHARS = 256;            // args.id + each args.ids element
export const MAX_IDS_ITEMS = 25;            // args.ids array length (REST parity)
export const MAX_CONSTRAINTS_KEYS = 16;     // keys in args.constraints
export const MAX_CONSTRAINTS_BYTES = 1024;  // UTF-8 bytes of JSON(constraints)
export const JSON_RPC_ERROR_CODE = -32001;  // server-error range; size/shape policy

const GUARD_MESSAGE = 'Request rejected: exceeds size/shape limits';

// CORS surface shared by EVERY response the MCP route emits — including the
// bodiless 202/204 ones, which must not claim a Content-Type they do not carry.
export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// Transport headers — single source of truth (also consumed by mcp.ts so the
// route and the guard cannot drift). HTTP 200 + JSON-RPC error body convention.
export const JSONRPC_HEADERS = { 'Content-Type': 'application/json', ...CORS_HEADERS };

// JSON-RPC 2.0 §5 (Response object, id): "This member is REQUIRED ... If there
// was an error in detecting the id in the Request object ... it MUST be Null."
// An undefined id is DROPPED entirely by JSON.stringify, so it is normalised to
// null here. This is the ONE error-response constructor for both the guard and
// the route (mcp.ts imports it as jsonrpcError), so the two layers cannot
// disagree on error shape. Non-nullish ids (including 0 and false) pass through.
export function rpcError(id: any, code: number, message: string, data?: any): Response {
    const error: any = { code, message };
    if (data !== undefined) error.data = data;
    return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error }),
        { headers: JSONRPC_HEADERS },
    );
}

// JSON-RPC 2.0 §4.1: "A Notification is a Request object without an "id"
// member. ... The Server MUST NOT reply to a Notification". MCP Streamable HTTP
// (spec version 2025-03-26, the version this server advertises in initialize):
// "If the input consists solely of (any number of) JSON-RPC responses or
// notifications: - If the server accepts the input, the server MUST return HTTP
// status code 202 Accepted with no body."
//
// BOTH conditions are required, and the whole predicate lives here so the route
// and the guard cannot drift on what "notification" means:
//   (1) the method sits in the reserved `notifications/` namespace, so EVERY
//       notification qualifies, not just the `notifications/initialized`
//       handshake message; and
//   (2) the id member is ABSENT.
// Condition (2) is `=== undefined`, deliberately NOT a nullish check:
// {"id":null,"method":"notifications/x"} HAS an id member, so by §4.1 it is not
// a notification, and §5 ("the Server MUST reply with a Response, except for in
// the case of Notifications") entitles it to a reply. JSON cannot encode an
// explicit `undefined`, so after JSON.parse an undefined id means exactly "no id
// member". An id-bearing `notifications/*` message is therefore NOT short-
// circuited: it falls through to the route's -32601 default and is answered with
// its own id echoed, which is the correct outcome for a non-notification.
export const isNotification = (method: any, id: any): boolean =>
    id === undefined && typeof method === 'string' && method.startsWith('notifications/');

// 202 Accepted, empty body. NEVER a fabricated success envelope such as
// {"result":{}} — that would be replying to a notification, which §4.1 forbids.
export const notificationAccepted = (): Response =>
    new Response(null, { status: 202, headers: CORS_HEADERS });

// Unified -32001 size/shape rejection. No input echo — only the violated cap
// token + its numeric ceiling.
function limitError(id: any, limit: string, max: number): Response {
    return rpcError(id, JSON_RPC_ERROR_CODE, GUARD_MESSAGE, { limit, max });
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

// --- G1: bounded body read ----------------------------------------------------
// Returns { text } on a clean read or { error } (a ready-to-return Response,
// id=null since the id is not yet parsed). Authoritative on every transfer
// encoding: Content-Length is only a fast-reject hint.
export async function readBoundedBody(
    request: { headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null },
): Promise<{ text: string } | { error: Response }> {
    // (a) FAST-REJECT HINT — honestly-declared oversize, body never read.
    const cl = request.headers.get('content-length');
    if (cl != null) {
        const declared = Number(cl);
        if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
            return { error: limitError(null, 'max_request_bytes', MAX_REQUEST_BYTES) };
        }
        // missing/invalid/negative/misleading -> fall through to the authoritative read.
    }

    // (b) AUTHORITATIVE BOUNDED READ — count RAW bytes, never decoded chars.
    const stream = request.body;
    if (!stream) return { text: '' }; // no body -> JSON.parse('') -> -32700 (unchanged)

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength; // raw Uint8Array byteLength (correction 1/3)
        if (total > MAX_REQUEST_BYTES) {
            await reader.cancel(); // stop reading the oversized body immediately (correction 7)
            return { error: limitError(null, 'max_request_bytes', MAX_REQUEST_BYTES) };
        }
        chunks.push(value);
    }

    // Decode ONLY after the byte ceiling has passed (correction 2). Streaming
    // decode across chunks reassembles multibyte sequences split on boundaries.
    const decoder = new TextDecoder();
    let text = '';
    for (const c of chunks) text += decoder.decode(c, { stream: true });
    text += decoder.decode();
    return { text };
}

// --- G2: structural / argument gate ------------------------------------------
// Bounded walk: returns true once a container nests deeper than `max` levels.
function exceedsDepth(value: any, max: number, depth = 1): boolean {
    if (value === null || typeof value !== 'object') return false;
    if (depth > max) return true;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
        if (exceedsDepth(child, max, depth + 1)) return true;
    }
    return false;
}

const isScalar = (v: any): boolean =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

// Returns a ready-to-return error Response (id echoed) on a violation, or null
// if the shape passes. Runs AFTER the bounded parse, BEFORE method/tool dispatch.
export function validateRpcShape(body: any): Response | null {
    const id = body && typeof body === 'object' ? (body.id ?? null) : null;

    // Depth first — cheap global JSON-bomb guard over the whole parsed body.
    if (exceedsDepth(body, MAX_NESTING_DEPTH)) {
        return limitError(id, 'max_nesting_depth', MAX_NESTING_DEPTH);
    }

    const args = body?.params?.arguments;
    if (!args || typeof args !== 'object') return null; // no tool args to check

    if (typeof args.query === 'string' && args.query.length > MAX_QUERY_CHARS) {
        return limitError(id, 'max_string_len_query', MAX_QUERY_CHARS);
    }
    if (typeof args.task === 'string' && args.task.length > MAX_TASK_CHARS) {
        return limitError(id, 'max_string_len_task', MAX_TASK_CHARS);
    }
    if (typeof args.id === 'string' && args.id.length > MAX_ID_CHARS) {
        return limitError(id, 'max_string_len_id', MAX_ID_CHARS);
    }
    if (Array.isArray(args.ids)) {
        if (args.ids.length > MAX_IDS_ITEMS) {
            return limitError(id, 'max_ids_items', MAX_IDS_ITEMS);
        }
        for (const el of args.ids) {
            if (typeof el !== 'string' || el.length > MAX_ID_CHARS) {
                return limitError(id, 'max_string_len_id', MAX_ID_CHARS);
            }
        }
    }
    const constraints = args.constraints;
    if (constraints && typeof constraints === 'object' && !Array.isArray(constraints)) {
        const keys = Object.keys(constraints);
        if (keys.length > MAX_CONSTRAINTS_KEYS) {
            return limitError(id, 'max_constraints_keys', MAX_CONSTRAINTS_KEYS);
        }
        if (utf8Bytes(JSON.stringify(constraints)) > MAX_CONSTRAINTS_BYTES) {
            return limitError(id, 'max_constraints_bytes', MAX_CONSTRAINTS_BYTES);
        }
        for (const k of keys) {
            if (!isScalar(constraints[k])) {
                return limitError(id, 'max_constraints_scalar', 0); // scalar-only
            }
        }
    }
    return null;
}

// --- Combined entry: G1 -> parse -> G2 ---------------------------------------
// Single helper so the route stays net-negative. Returns { body } for a clean,
// in-spec request, or { error } (a ready Response) for any guard/parse failure.
// Ordering is the core security property: byte gate (pre-parse) -> JSON.parse ->
// structural gate (post-parse, pre-dispatch). No caller-side dispatch precedes a
// clean pass of both gates.
export async function guardAndParse(
    request: { headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null },
): Promise<{ body: any } | { error: Response }> {
    const bounded = await readBoundedBody(request); // G1
    if ('error' in bounded) return { error: bounded.error };

    let body: any;
    try {
        body = JSON.parse(bounded.text);
    } catch {
        return { error: rpcError(null, -32700, 'Parse error') }; // unchanged -32700
    }

    const shapeError = validateRpcShape(body); // G2
    if (shapeError) return { error: shapeError };
    return { body };
}
