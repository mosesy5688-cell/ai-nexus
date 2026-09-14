/**
 * JSON-RPC 2.0 Sec 6 batch RECEIVE for the MCP route.
 *
 * MCP spec 2025-03-26, /basic/index Sec Batching -- the version this server
 * advertises in its own initialize response: "MCP implementations MAY support
 * sending JSON-RPC batches, but MUST support receiving JSON-RPC batches."
 * This module implements the MUST (receiving) only. Nothing here SENDS a batch.
 *
 * DESIGN RULE (the whole point of the file): a batch member is executed by the
 * SAME dispatcher the route uses for a single message, and that member's
 * response BYTES are spliced into the array verbatim -- not re-parsed, not
 * re-serialised. A member's element is therefore the body that member would
 * have received had it been POSTed on its own -- same -32601 / -32603 text,
 * same id echo, same id:null normalisation -- because it is the same code, not
 * a second implementation of it. Two measured exceptions to that parity, both
 * inherited rather than introduced here, are recorded so the sentence above is
 * not read as absolute: (1) the route's G2 depth gate walks the WHOLE body, and
 * an array is one more container level, so a member sitting exactly at the
 * depth boundary passes alone but is rejected -32001 with its whole batch
 * (measured: tools/call arguments nested 6 deep flips there); (2) a member whose
 * dispatch THROWS is answered with a -32603 element by the catch in the member
 * loop below, instead of the exception that same message raises when it is the
 * whole body. That divergence is deliberate and is explained at the catch.
 *
 * A `null` SINGLE body is NOT touched by that catch and still throws at the
 * route's unconditional destructure, exactly as it does on main: that defect is
 * pre-existing, has its own track, and this module neither fixes nor hides it.
 *
 * Sec 6, on what the array holds:
 *   "A Response object SHOULD exist for each Request object, except" ...
 *   "there SHOULD NOT be any Response objects for notifications"
 * Sec 6, on a batch that yields nothing:
 *   "the server MUST NOT return an empty Array and should return nothing at all"
 * Over Streamable HTTP "nothing at all" is the 202-with-no-body that MCP already
 * mandates for input consisting solely of responses or notifications, so the
 * all-notification batch reuses the route's existing notificationAccepted().
 * Sec 6, on a batch that is not an Array with at least one value:
 *   "If the batch rpc call itself fails to be recognized as an valid JSON or as
 *   an Array with at least one value," ... "the response from the Server MUST be
 *   a single Response object" -- and the section's worked example answers []
 *   with error -32600 "Invalid Request" and id null. That is the [] branch here.
 *
 * Members are dispatched in array order, one at a time (awaited in sequence).
 * Sec 6 permits any processing order; sequential execution is chosen so a batch
 * cannot fan a cold search/VFS/R2 path out concurrently inside one invocation.
 *
 * A member is dispatched as a SINGLE MESSAGE, never re-entered here as a batch
 * (dispatchOne, not dispatchRpc): Sec 6 defines no nested batch. So an array
 * MEMBER lands on the route's unknown-method path and is answered -32601
 * "Method not found: undefined" (measured: [[]] -> one -32601 element).
 *
 * That -32601 is NOT what every non-Request member gets, and the difference is
 * worth stating because it is the one place this module answers LESS than main
 * did. A member that is merely an object with no `id` -- Sec 6's own worked
 * example `{"foo":"boo"}` is exactly that -- satisfies the standing id-absence
 * rule for a notification, so it is accepted in silence and contributes no
 * element. Measured: [{"foo":"boo"}] -> 202 with an empty body, and an
 * all-garbage batch [{"a":1},{"b":2},{"c":3}] -> 202 with an empty body, where
 * origin/main answered both with a visible -32601. Silence is the DESIGNED
 * answer there: it is exact parity with sending that member alone, and the
 * id-absence rule is a standing ruling this module does not relitigate. A
 * caller that wants an answer must give the member an `id`; one that does gets
 * its element ([{"foo":"boo"},{"id":5,...}] -> one element, id 5, measured).
 *
 * Sec 6's example answers an invalid member -32600 instead of -32601; this path
 * deliberately does not special-case that, because -32601 is the route's
 * existing single-message answer for a non-Request body and changing it would
 * be a single-message change, out of scope for this module.
 *
 * MAX_BATCH_MEMBERS bounds the member count BEFORE any member is dispatched.
 * Without it, measured on this branch: 1960 minimal `tools/list` members fit in
 * one 65,534-byte POST (G1's MAX_REQUEST_BYTES) and returned 15,237,894 bytes
 * -- 232.5x amplification, a ~14.5 MiB string assembled while the element array
 * is still live -- and 675 `tools/call` members fit, each able to enter the
 * search path, dispatched sequentially. Sequential execution bounds PARALLELISM,
 * not total work; the count bound is what limits total work here (a batch-wide
 * time budget would bound it differently, and is not decided here, see below).
 * At 25 the same tools/list
 * batch returns 194,317 bytes (189.8 KiB, measured), 78x smaller. The cap is a
 * member of the existing mcp-guard cap family, rejected in that family's exact
 * -32001 shape via its own limitError, not a new error surface. It does not
 * conflict with the MCP MUST: the spec requires receiving batches, not unbounded
 * ones. What it does NOT bound is wall-clock: 25 sequential tool calls can still
 * exceed any plausible request budget, and bounding that needs a batch-wide time
 * budget -- a separate mechanism over frozen constants, not decided here.
 */
import {
    JSONRPC_HEADERS, rpcError, notificationAccepted, validateRpcShape,
    limitError, MAX_BATCH_MEMBERS,
} from './mcp-guard.js';

/** Executes one JSON-RPC message and returns the Response it would get alone. */
type DispatchOne = (message: any) => Promise<Response>;

/**
 * Route a parsed (post-guard) JSON-RPC body. A non-array body goes straight to
 * the single-message dispatcher, unchanged. An array is handled per Sec 6.
 *
 * The G2 structural gate re-runs per member (validateRpcShape). The route-level
 * gate sees the ARRAY, whose `params` is undefined, so without this a member
 * could carry arguments that the same message could not carry when sent alone
 * (an over-cap ids[] the compare fan-out would then honour). A rejected member
 * yields the -32001 Response it would have been given alone, in its own slot.
 */
export async function dispatchRpc(body: any, dispatchOne: DispatchOne): Promise<Response> {
    if (!Array.isArray(body)) return dispatchOne(body);
    if (body.length === 0) return rpcError(null, -32600, 'Invalid Request');
    // Count bound, BEFORE the loop: an over-cap batch executes no member at all,
    // which is the whole point of a pre-dispatch gate. Same -32001 envelope as
    // every other cap in the family (see the header for the measurements).
    if (body.length > MAX_BATCH_MEMBERS) {
        return limitError(null, 'max_batch_members', MAX_BATCH_MEMBERS);
    }

    const elements: string[] = [];
    for (const member of body) {
        let text: string;
        try {
            const shapeError = validateRpcShape(member);
            const res = shapeError ? shapeError : await dispatchOne(member);
            text = await res.text();
        } catch {
            // A member that throws must not take its SIBLINGS' answers with it.
            // Measured: `null` passes validateRpcShape (its id reads null-safely,
            // depth does not trip, and params?.arguments is undefined), then the
            // route's unconditional destructure throws on it. Without this catch
            // the rejection escapes dispatchRpc, the route 500s, and a valid
            // request sharing the array loses the response Sec 5 owes it -- a
            // failure mode batching would be INTRODUCING, distinct from the
            // pre-existing single-null defect, which stays exactly as it is.
            //
            // -32603 "Internal error" is the code precisely because dispatch
            // failed for a reason this layer did not establish. -32600 Invalid
            // Request would assert a shape verdict that was never reached (the
            // shape gate passed the member) and would contradict this module's
            // other choice, above, to leave a non-Request member on the route's
            // own -32601 rather than reclassify it here. The exception text is
            // NOT echoed: it names internals and the caller cannot act on it.
            // Built through the same rpcError() every other element uses, so the
            // id normalisation and key order are the shared ones, not new ones.
            text = await rpcError(member?.id, -32603, 'Internal error').text();
        }
        // An empty body is how the 202 notification acknowledgement is shaped.
        // Every other return in the single-message dispatcher goes through
        // jsonrpc() or rpcError(), which both stringify a non-empty body, so an
        // empty body here means "this member is a notification, no element".
        if (text !== '') elements.push(text);
    }

    if (elements.length === 0) return notificationAccepted();
    return new Response(`[${elements.join(',')}]`, { headers: JSONRPC_HEADERS });
}
