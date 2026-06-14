/**
 * SRS-2 — API / MCP / Cross-Consumer DEPLOYED baseline (informational, non-blocking).
 *
 * Permanentizes the manual R0 evidence for the REST API, the MCP JSON-RPC server,
 * and Frontend<->REST<->MCP cross-consumer parity, against DEPLOYED PROD (BASE_URL,
 * default https://free2aitools.com). REUSES the mature SRS-2A harness (NO duplicated
 * classifier): the same provenance record/CellState model + run artifact
 * (srs2a-helpers), the same bounded <=2 Retry-After retry, the same request-rate
 * control (paceNavigation) + dedup + descriptive UA (srs2-api-helpers/mcp-helpers),
 * and the same 429/503 -> INCONCLUSIVE_TRANSIENT intent (a transient is NOT a pass,
 * NOT a product defect, NOT a closed cell). Workers pinned to 1, serial ordering.
 * Contract assertions (status/shape/nullability/parity/negative-contract) stay STRICT.
 *
 * REST cells live in ./srs2-api-tests (registerApiTests) to honor the 250-line CES
 * floor; MCP + cross-consumer cells are below.
 */
import { test, expect } from '@playwright/test';
import { isTransient, shapedFetch, safeJson, resetDedup, record } from './srs2-api-helpers';
import {
    MCP_TOOLS, MCP_MANIFEST_PATH, rpc, callTool, toolText, isRpcSuccess, isRpcError, isToolError,
    hasDrift, recordMcp, isTransientToolResult,
} from './srs2-mcp-helpers';
import { registerApiTests, apiGet, sampleIds } from './srs2-api-tests';
import { discoverBuildId, discoverSnapshotId, emitRunArtifact, TEST_UA } from './srs2a-helpers';

void expect; // shared assertion lib pinned for parity with srs2a; cells use record()

test.describe.configure({ mode: 'serial' });
test.use({ userAgent: TEST_UA });

let BUILD_ID = 'undiscoverable';
let SNAPSHOT_ID = 'unobservable';
test.beforeAll(async ({ request }) => {
    BUILD_ID = await discoverBuildId(request as any);
    SNAPSHOT_ID = await discoverSnapshotId(request as any);
});
test.afterAll(async () => { await emitRunArtifact(BUILD_ID, SNAPSHOT_ID); });

test.describe('SRS-2 API/MCP/cross-consumer deployed baseline @informational', () => {
    // ---- REST API live baseline (per endpoint) [API_CONTRACT_MATRIX] ----------
    registerApiTests(test);

    // ---- MCP JSON-RPC live baseline [MCP_PARITY_MATRIX] -----------------------

    test('mcp: initialize + SERVER_BOUNDARY instructions present [MCP:initialize]', async ({ request }) => {
        const r = await rpc(request as any, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} });
        const instr = String(r.body?.result?.instructions || '');
        const boundaryOk = /does not/i.test(instr) && /(recommend|workflow|decide|compatibility|semantic)/i.test(instr);
        recordMcp('mcp-initialize', 'initialize + SERVER_BOUNDARY instructions', r, isRpcSuccess(r) && !!r.body?.result?.serverInfo && boundaryOk, { keyFields: { hasBoundary: boundaryOk } });
    });

    test('mcp: tools/list = static manifest 5-tool parity [MCP:tools-parity]', async ({ request }) => {
        const r = await rpc(request as any, 'tools/list');
        const dynamic = (r.body?.result?.tools || []).map((t: any) => t.name).sort();
        const { resp: mResp } = await shapedFetch(request as any, 'GET', MCP_MANIFEST_PATH);
        const staticNames = ((await safeJson(mResp)).data?.tools || []).map((t: any) => t.name).sort();
        const expected = [...MCP_TOOLS].sort();
        const parity = JSON.stringify(dynamic) === JSON.stringify(expected) && JSON.stringify(staticNames) === JSON.stringify(expected);
        recordMcp('mcp-tools-parity', 'dynamic tools/list == static mcp.json == locked 5 set', r, parity, { keyFields: { dynamic, staticNames } });
    });

    for (const [tool, args, label] of [
        ['free2aitools_search', { query: 'llama', limit: 5 }, 'search'],
        ['free2aitools_rank', { query: 'summarize', limit: 5 }, 'rank'],
        ['free2aitools_select_model', { task: 'summarize text', limit: 3 }, 'select_model'],
    ] as Array<[string, Record<string, unknown>, string]>) {
        test(`mcp tool ${label}: success path + no verdict/recommendation drift [MCP:${label}]`, async ({ request }) => {
            const r = await callTool(request as any, tool, args);
            if (isTransientToolResult(r)) { recordMcp(`mcp-${label}`, 'success or transient', r, false, { transientTool: true }); return; }
            const text = toolText(r);
            // A legitimately-empty result set (entries:[]) is STILL a valid success;
            // require a well-formed non-error envelope + NO pick/verdict/routing drift.
            const ok = isRpcSuccess(r) && !isToolError(r) && !hasDrift(text);
            recordMcp(`mcp-${label}`, 'tool result, NO pick/verdict/routing drift', r, ok, { keyFields: { drift: hasDrift(text), textLen: text.length } });
        });
    }

    test('mcp explain: success on real id + honest miss (non-error result) [MCP:explain]', async ({ request }) => {
        const id = (await sampleIds(request as any, 1))[0];
        test.skip(!id, 'need a real id for explain');
        const r = await callTool(request as any, 'free2aitools_explain', { id });
        if (isTransientToolResult(r)) recordMcp('mcp-explain', 'success or transient', r, false, { transientTool: true });
        else recordMcp('mcp-explain', 'factor breakdown, no verdict', r, isRpcSuccess(r) && !hasDrift(toolText(r)));
        const miss = await callTool(request as any, 'free2aitools_explain', { id: `zz-nonexistent-${Date.now().toString(36)}` });
        if (isTransientToolResult(miss)) recordMcp('mcp-explain-miss', 'honest miss', miss, false, { transientTool: true });
        else recordMcp('mcp-explain-miss', 'non-error result on miss (not fabricated)', miss, isRpcSuccess(miss) && !isToolError(miss) && /no entity|not found|no match/i.test(toolText(miss)));
    });

    test('mcp compare: success + SAFE invalid input -> structured error [MCP:compare]', async ({ request }) => {
        const ids = await sampleIds(request as any, 2);
        test.skip(ids.length < 2, 'need 2 ids for mcp compare');
        const r = await callTool(request as any, 'free2aitools_compare', { ids });
        if (isTransientToolResult(r)) recordMcp('mcp-compare', 'success or transient', r, false, { transientTool: true });
        else recordMcp('mcp-compare', 'compare result, no routing drift', r, isRpcSuccess(r) && !hasDrift(toolText(r)));
        const bad = await callTool(request as any, 'free2aitools_compare', { ids: [ids[0]] });
        recordMcp('mcp-compare-invalid', 'structured error on <2 ids', bad, (isRpcError(bad) || isToolError(bad)) && bad.status < 500, { keyFields: { rpcError: isRpcError(bad), toolError: isToolError(bad) } });
    });

    test('mcp: unknown method/tool -> structured JSON-RPC error (no crash) [MCP:errors]', async ({ request }) => {
        const m = await rpc(request as any, 'does/not/exist');
        recordMcp('mcp-unknown-method', '-32601 method not found', m, isRpcError(m) && m.body?.error?.code === -32601);
        const t = await callTool(request as any, 'free2aitools_nonexistent', {});
        recordMcp('mcp-unknown-tool', 'structured error on unknown tool', t, isRpcError(t) || isToolError(t));
    });

    // ---- Cross-consumer parity: Frontend <-> REST <-> MCP [XC] ----------------

    test('cross-consumer parity: REST entity <-> MCP explain agree (id/fni/semantic null) [XC:parity]', async ({ request }) => {
        resetDedup();
        const id = (await sampleIds(request as any, 1))[0];
        test.skip(!id, 'need a real id for cross-consumer parity');
        const { resp, data: ent } = await apiGet(request as any, `/api/v1/entity/${encodeURIComponent(id)}`);
        const mcp = await callTool(request as any, 'free2aitools_explain', { id });
        if (isTransient(resp.status()) || isTransientToolResult(mcp)) {
            record({ assertion: 'xc-parity', expected: 'REST<->MCP agree', actual: 'transient on one consumer', state: 'INCONCLUSIVE_TRANSIENT', keyFields: { id, restStatus: resp.status() } });
            test.skip(true, 'transient on a consumer (INCONCLUSIVE; cell UNCLOSED)');
        }
        const mtext = toolText(mcp);
        let mjson: any = null; try { mjson = JSON.parse(mtext); } catch { /* explain may return a plain breakdown */ }
        const restScore = ent?.entity?.fni?.score;
        const mcpScore = mjson?.fni_score ?? mjson?.factors ?? undefined;
        const restSemanticNull = ent?.entity?.fni?.factors?.semantic === null;
        const mcpSemanticNull = !mjson || mjson?.factors?.S_semantic === null || /null/i.test(mtext);
        const idAgrees = mtext.includes(String(ent?.entity?.id || id)) || (mjson && (mjson.id === ent?.entity?.id || mjson.id === id));
        const ok = isRpcSuccess(mcp) && !isToolError(mcp) && restSemanticNull && mcpSemanticNull && idAgrees && typeof restScore !== 'undefined' && typeof mcpScore !== 'undefined' && !hasDrift(mtext);
        record({ assertion: 'xc-parity', expected: 'same id + both semantic null + score present + no drift', actual: `rest.score=${restScore} mcpScore=${mcpScore !== undefined} restNull=${restSemanticNull} mcpNull=${mcpSemanticNull} idAgrees=${idAgrees}`, state: ok ? 'PASS' : 'PRODUCT_FAILURE', keyFields: { id, restScore } });
    });

    test('cross-consumer miss parity: REST 404 vs MCP honest-miss agree (no fabrication) [XC:miss]', async ({ request }) => {
        const fake = `zz-nonexistent-${Date.now().toString(36)}`;
        const { resp } = await shapedFetch(request as any, 'GET', `/api/v1/entity/${fake}`);
        const mcp = await callTool(request as any, 'free2aitools_explain', { id: fake });
        if (isTransient(resp.status()) || isTransientToolResult(mcp)) {
            record({ assertion: 'xc-miss', expected: 'REST 404 ~ MCP honest miss', actual: 'transient', state: 'INCONCLUSIVE_TRANSIENT', keyFields: { fake } });
            test.skip(true, 'transient on miss probe (INCONCLUSIVE)');
        }
        const restMiss = resp.status() === 404;
        const mcpMiss = isRpcSuccess(mcp) && !isToolError(mcp) && /no entity|not found|no match/i.test(toolText(mcp));
        record({ assertion: 'xc-miss', expected: 'REST 404 + MCP non-error honest miss (neither fabricated)', actual: `restMiss=${restMiss} mcpMiss=${mcpMiss}`, state: restMiss && mcpMiss ? 'PASS' : 'PRODUCT_FAILURE', keyFields: { fake } });
    });
});
