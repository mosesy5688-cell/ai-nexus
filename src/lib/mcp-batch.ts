/**
 * JSON-RPC 2.0 Sec 6 batch RECEIVE for the MCP route.
 *
 * MCP 2025-03-26, /basic/index Sec Batching -- the version this server advertises
 * in its own initialize response: "MCP implementations MAY support sending
 * JSON-RPC batches, but MUST support receiving JSON-RPC batches." This module
 * implements the MUST (receiving). Nothing here SENDS a batch.
 *
 * MEASUREMENTS AND DERIVATION HISTORY LIVE IN PR #2320, NOT HERE. Amplification
 * figures, member-count packings, response sizes and the wall-clock arithmetic
 * are recorded there, where they are dated and not re-verified on every edit.
 * The only figure kept in this file is the one a test pins: MAX_BATCH_MEMBERS.
 *
 * DESIGN RULE: a batch member is executed by the SAME dispatcher the route uses
 * for a single message, and that member's response BYTES are spliced into the
 * array verbatim -- not re-parsed, not re-serialised. A member's element is
 * therefore the body that member would have received had it been POSTed alone,
 * because it is the same code, not a second implementation. Two measured
 * exceptions, both inherited rather than introduced here:
 *   (1) the route's G2 depth gate walks the WHOLE body, and an array is one more
 *       container level, so a member sitting exactly at the depth boundary
 *       passes alone but is rejected -32001 with its whole batch;
 *   (2) a member whose dispatch THROWS gets a -32603 element from the catch in
 *       the member loop, instead of the exception the same message raises when
 *       it is the whole body. A `null` SINGLE body is untouched by that catch
 *       and still throws at the route's unconditional destructure: that defect
 *       is pre-existing, has its own track, and is neither fixed nor hidden.
 *
 * Sec 6, on what the array holds:
 *   "A Response object SHOULD exist for each Request object, except" ...
 *   "there SHOULD NOT be any Response objects for notifications"
 * Sec 6, on a batch that yields nothing:
 *   "the server MUST NOT return an empty Array and should return nothing at all"
 * Sec 6, on a batch that is not an Array with at least one value:
 *   "If the batch rpc call itself fails to be recognized as an valid JSON or as
 *   an Array with at least one value," ... "the response from the Server MUST be
 *   a single Response object" -- its worked example answers [] with -32600
 *   "Invalid Request" and id null, which is the [] branch here.
 *
 * TRANSPORT RULES THAT DECIDE THE HTTP STATUS. MCP 2025-03-26 /basic/transports,
 * "Sending Messages to the Server", rules 4 and 5, verbatim:
 *   4. "If the input consists solely of (any number of) JSON-RPC responses or
 *      notifications:
 *        - If the server accepts the input, the server MUST return HTTP status
 *          code 202 Accepted with no body.
 *        - If the server cannot accept the input, it MUST return an HTTP error
 *          status code (e.g., 400 Bad Request). The HTTP response body MAY
 *          comprise a JSON-RPC error response that has no `id`."
 *   5. "If the input contains any number of JSON-RPC requests, the server MUST
 *      either return Content-Type: text/event-stream ... or Content-Type:
 *      application/json, to return one JSON object."
 * So refusal is not one behaviour, it is two, and the input's shape picks which:
 *   - EVERY member a notification -> rule 4 -> HTTP 400, and no body at all.
 *     An empty body cannot carry an `id`, so the MAY-clause is satisfied by
 *     construction rather than by remembering to omit one.
 *   - ANY member a request -> rule 5 -> HTTP 200 + application/json + one JSON
 *     object, which is the -32001 the cap family already emits.
 * Classification is a pure shape test over the members; NOTHING is dispatched.
 *
 * DELIBERATE DEVIATIONS, all three disclosed rather than discovered later:
 *   a) An array MEMBER is dispatched as a SINGLE MESSAGE, never re-entered as a
 *      batch (Sec 6 defines no nested batch), so it lands on the route's
 *      unknown-method path and is answered -32601, where Sec 6's example uses
 *      -32600. Changing that would be a single-message change, out of scope.
 *   b) A member that is an object with no `id` -- Sec 6's own `{"foo":"boo"}` --
 *      is a notification under the standing id-absence rule, so it is accepted
 *      in silence and contributes no element. An all-garbage batch is therefore
 *      answered 202 with an empty body where main answered -32601. That costs
 *      DIAGNOSABILITY and is still the designed answer: it is exact parity with
 *      sending that member alone. (An all-notification batch is also answered
 *      with fewer bytes than main, but nothing is lost there -- 202-with-no-body
 *      is the complete answer rule 4 mandates.)
 *   c) A request-bearing batch refused by the cap is answered with a SINGLE
 *      Response object, not one error element per member. Sec 6's
 *      MUST-single-object clause does not cover it (a 26-member array IS an
 *      Array with at least one value; the SHOULD-array clause covers it), so
 *      this is a deviation, taken because the refusal is about the batch AS A
 *      WHOLE -- no member ran -- and one element per member would assert
 *      per-member verdicts that were never reached. It matches the pre-existing
 *      route-level depth rejection, which answers even a 1-member batch with a
 *      single -32001 object.
 *
 * MAX_BATCH_MEMBERS bounds the member count BEFORE any member is dispatched.
 * Reusing the guard family's -32001 envelope is NOT the same as adding no
 * rejection: this is a new branch, firing when a parsed body is an array of more
 * than MAX_BATCH_MEMBERS members, and inputs that were answered before it are
 * now refused. It does not conflict with the MCP MUST, which requires receiving
 * batches, not unbounded ones. What it bounds is member dispatches and, with
 * them, the ELEMENT COUNT -- so a response is at most MAX_BATCH_MEMBERS
 * single-message bodies. That is a multiple of the largest single-message body,
 * NOT a fixed byte ceiling: element size varies with the tool AND with the
 * request (ids are echoed into every element). It does NOT bound wall-clock or
 * total backend work; that needs a batch-wide time budget, not decided here.
 * Sequential dispatch is a concurrency choice and bounds neither.
 *
 * Members are dispatched in array order, one at a time. Sec 6 permits any order;
 * sequential is chosen so a batch cannot fan a cold search/VFS/R2 path out
 * concurrently inside one invocation.
 */
import {
    JSONRPC_HEADERS, CORS_HEADERS, rpcError, notificationAccepted, validateRpcShape,
    isNotification, limitError, MAX_BATCH_MEMBERS,
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
    // every other cap in the family (measurements: PR #2320, not this file).
    if (body.length > MAX_BATCH_MEMBERS) {
        // Refusal is two behaviours, picked by the input's shape (transport
        // rules 4 and 5, quoted in the header). Pure shape test -- no member is
        // dispatched on either arm. A body-less 400 cannot carry an `id`, so
        // rule 4's "error response that has no id" holds by construction.
        if (body.every(isNotification)) return new Response(null, { status: 400, headers: CORS_HEADERS });
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
