/**
 * SRS-2 — REST API live-baseline cells (split out to honor the 250-line CES floor).
 *
 * registerApiTests(test) attaches the per-endpoint REST contract cells of the
 * API_CONTRACT_MATRIX. Each cell uses the SAME shaped fetch + provenance record +
 * 429/503 -> INCONCLUSIVE_TRANSIENT model as the rest of the SRS-2 baseline (no
 * duplicated classifier). The orchestration spec (srs2-api-mcp-baseline.spec)
 * imports this + the MCP/cross-consumer cells. Also exports the shared sampleIds /
 * apiGet / findLimitMax used by the cross-consumer cells.
 */
import { isTransient, shapedFetch, safeJson, contentTypeIs, recordApi, recordApiStaged, toAttempt, resetDedup, record, type ApiRequest } from './srs2-api-helpers';
import { resolveRealSlug } from './srs2a-helpers';

/** GET helper: resp + parsed json + retries via the shaped transport. */
export async function apiGet(request: ApiRequest, path: string) {
    const { resp, retries } = await shapedFetch(request, 'GET', path);
    const { ok, data, raw } = await safeJson(resp);
    return { resp, retries, ok, data, raw };
}

/** Resolve N real catalog ids/slugs from the live search API (fixed-sample source). */
export async function sampleIds(request: ApiRequest, n: number): Promise<string[]> {
    const out: string[] = [];
    for (const [type, qs] of [['model', ['llama', 'qwen', 'mistral']], ['paper', ['llm', 'transformer']], ['dataset', ['bench', 'text']]] as Array<[string, string[]]>) {
        if (out.length >= n) break;
        const slug = await resolveRealSlug(request as any, type, qs);
        if (slug && !out.includes(slug)) out.push(slug);
    }
    return out.slice(0, n);
}

/** Extract the search `limit` parameter max from the OpenAPI doc (declared 20). */
export function findLimitMax(doc: any): number | undefined {
    const params = doc?.paths?.['/api/v1/search']?.get?.parameters || [];
    return params.find((p: any) => p?.name === 'limit')?.schema?.maximum;
}

/** CompareResponse.entities[].fni_factors.semantic nullable flag. The entities
 *  items use a `oneOf` (resolved entity | {id,found:false} placeholder); the
 *  semantic.nullable lives on the RESOLVED branch's fni_factors. */
export function compareSemanticNullable(doc: any): boolean | undefined {
    const items = doc?.components?.schemas?.CompareResponse?.properties?.entities?.items;
    const branches: any[] = items?.oneOf || (items ? [items] : []);
    for (const b of branches) {
        const n = b?.properties?.fni_factors?.properties?.semantic?.nullable;
        if (typeof n === 'boolean') return n;
    }
    return undefined;
}

type T = typeof import('@playwright/test')['test'];

export function registerApiTests(test: T): void {
    test('search: 200 shape + limit max=20 cap + honest empty + nullable fni_s [API:search]', async ({ request }) => {
        const { resp, retries, data } = await apiGet(request as any, '/api/v1/search?q=llama&type=model&limit=99');
        if (!isTransient(resp.status())) {
            const results = Array.isArray(data?.results) ? data.results : [];
            const shapeOk = data?.version === 'fni_v2.0' && Array.isArray(data?.results) && typeof data?.total_count !== 'undefined';
            const nullSemantic = results.length === 0 || results.every((r: any) => r.fni_s === null || r.fni_s === undefined);
            recordApi('search-success', '200 fni_v2.0 + limit<=20 + fni_s null', resp, resp.status() === 200 && shapeOk && results.length <= 20 && nullSemantic && contentTypeIs(resp, 'json'), { retries, keyFields: { count: results.length } });
        } else recordApi('search-success', '200', resp, false, { retries });
        const miss = await apiGet(request as any, '/api/v1/search?q=zzqxnonexistent9988&type=model&limit=5');
        if (!isTransient(miss.resp.status())) {
            const empty = Array.isArray(miss.data?.results) && miss.data.results.length === 0;
            recordApi('search-honest-empty', '200 empty array (not 404)', miss.resp, miss.resp.status() === 200 && empty, { retries: miss.retries });
        } else recordApi('search-honest-empty', '200 empty', miss.resp, false);
    });

    test('select: 200 entries + semantic null + 400 invalid (never 500) [API:select]', async ({ request }) => {
        const { resp, retries } = await shapedFetch(request as any, 'POST', '/api/v1/select', { data: { task: 'summarize text', limit: 99 } });
        const { data } = await safeJson(resp);
        if (!isTransient(resp.status())) {
            const entries = Array.isArray(data?.entries) ? data.entries : [];
            const ok = resp.status() === 200 && data?.version === 'fni_v2.0' && Array.isArray(data?.entries) && entries.length <= 20 && entries.every((e: any) => e?.fni_factors?.semantic === null);
            recordApi('select-success', '200 + entries<=20 + semantic null', resp, ok, { retries });
        } else recordApi('select-success', '200', resp, false, { retries });
        const { resp: bad } = await shapedFetch(request as any, 'POST', '/api/v1/select', { data: { limit: 5 } });
        recordApi('select-invalid-400', '400 not 500 on missing task', bad, bad.status() === 400, { keyFields: { note: 'SAFE invalid input' } });
    });

    test('compare: 200 + semantic nullable + found flags + 400 boundary [API:compare]', async ({ request }) => {
        const ids = await sampleIds(request as any, 2);
        test.skip(ids.length < 2, 'need 2 real ids for compare');
        const { resp, retries, data } = await apiGet(request as any, `/api/v1/compare?ids=${ids.map(encodeURIComponent).join(',')}`);
        if (!isTransient(resp.status())) {
            const ents = Array.isArray(data?.entities) ? data.entities : [];
            const semanticNull = ents.every((e: any) => !e.found || e?.fni_factors?.semantic === null);
            recordApi('compare-success', '200 + semantic null + meta.requested', resp, resp.status() === 200 && data?.version === 'fni_v2.0' && ents.length >= 2 && semanticNull && typeof data?.meta?.requested === 'number', { retries });
        } else recordApi('compare-success', '200', resp, false, { retries });
        const { resp: one } = await shapedFetch(request as any, 'GET', `/api/v1/compare?ids=${encodeURIComponent(ids[0])}`);
        recordApi('compare-boundary-400', '400 on <2 ids', one, one.status() === 400, { keyFields: { boundary: '<2 ids' } });
    });

    test('entity: 200 stats container + nullable fields + honest 404/503 + 400 [API:entity]', async ({ request }) => {
        const id = (await sampleIds(request as any, 1))[0];
        test.skip(!id, 'need a real entity id');
        const { resp, retries, data } = await apiGet(request as any, `/api/v1/entity/${encodeURIComponent(id)}`);
        if (!isTransient(resp.status())) {
            const e = data?.entity;
            recordApi('entity-success', '200 + stats object + semantic null', resp, resp.status() === 200 && data?.version === 'fni_v2.0' && !!e && typeof e.stats === 'object' && e?.fni?.factors?.semantic === null, { retries, keyFields: { id } });
        } else recordApi('entity-success', '200', resp, false, { retries });
        const { resp: miss } = await shapedFetch(request as any, 'GET', `/api/v1/entity/zz-nonexistent-${Date.now().toString(36)}`);
        recordApi('entity-honest-miss', '404 honest (or 503 transient), never fabricated 200', miss, miss.status() === 404, { keyFields: { split: '404-vs-503' } });
    });

    test('badge: 200 svg content-type + 404 svg on miss [API:badge]', async ({ request }) => {
        const id = (await sampleIds(request as any, 1))[0];
        test.skip(!id, 'need a real id for badge');
        const { resp } = await shapedFetch(request as any, 'GET', `/api/v1/badge/${encodeURIComponent(id)}`);
        if (!isTransient(resp.status())) recordApi('badge-success', '200 image/svg+xml', resp, resp.status() === 200 && contentTypeIs(resp, 'svg'), { keyFields: { id } });
        else recordApi('badge-success', '200 svg', resp, false);
        const { resp: miss } = await shapedFetch(request as any, 'GET', `/api/v1/badge/zz-nonexistent-${Date.now().toString(36)}`);
        recordApi('badge-miss-404', '404 (still SVG, distinguishes missing)', miss, miss.status() === 404 && contentTypeIs(miss, 'svg'));
    });

    test('health: 200 status ok + no-store [API:health]', async ({ request }) => {
        const { resp, data } = await apiGet(request as any, '/api/v1/health');
        const ok = resp.status() === 200 && data?.status === 'ok' && data?.version === 'fni_v2.0';
        recordApi('health', '200 status=ok no-store', resp, ok && (resp.headers()['cache-control'] || '').includes('no-store'));
    });

    test('datasets: 200 manifest + files[] + 404 on unknown file [API:datasets]', async ({ request }) => {
        const { resp, data } = await apiGet(request as any, '/api/v1/datasets');
        if (!isTransient(resp.status())) recordApi('datasets-success', '200 + files[]', resp, resp.status() === 200 && data?.version === 'fni_v2.0' && Array.isArray(data?.files));
        else recordApi('datasets-success', '200', resp, false);
        const { resp: bad } = await shapedFetch(request as any, 'GET', '/api/v1/datasets?file=zz-unknown-file');
        recordApi('datasets-unknown-404', '404 on unknown file', bad, bad.status() === 404);
    });

    test('concepts: 200 knowledge_v1 + limit cap + 400 bad category [API:concepts]', async ({ request }) => {
        // STAGED 5xx: an unexpected 500 here (run 27500238680) is NEVER an immediate
        // PRODUCT_FAILURE — bounded <=2 GET-only same-input corroboration adjudicates
        // intermittent vs deterministic; every attempt is preserved (no suppression).
        const CONCEPTS = '/api/v1/concepts?limit=999';
        const conceptsContractOk = (st: number, d: any): boolean => {
            const c = Array.isArray(d?.concepts) ? d.concepts : [];
            return st === 200 && d?.version === 'knowledge_v1' && Array.isArray(d?.concepts) && c.length <= 200;
        };
        const probe = async () => {
            resetDedup(); // genuine re-probe (not coalesced); same endpoint + valid input class, GET only
            const { resp: rp, data: dp, ok } = await apiGet(request as any, CONCEPTS);
            return toAttempt(rp, ok && conceptsContractOk(rp.status(), dp));
        };
        const { resp, data, raw, ok } = await apiGet(request as any, CONCEPTS) as any;
        await recordApiStaged('concepts-success', '200 knowledge_v1 + limit<=200', resp, ok && conceptsContractOk(resp.status(), data), probe, { raw, keyFields: { count: Array.isArray(data?.concepts) ? data.concepts.length : 0 } });
        const { resp: bad } = await shapedFetch(request as any, 'GET', '/api/v1/concepts?category=Bad_Category!');
        const be = (await safeJson(bad)).data;
        recordApi('concepts-invalid-400', '400 structured on bad category', bad, bad.status() === 400 && be?.error === true);
    });

    test('trends/batch: 200 map + missing[] + 400 boundary [API:trends]', async ({ request }) => {
        const ids = await sampleIds(request as any, 2);
        test.skip(ids.length < 1, 'need a real id for trends');
        const { resp, retries, data } = await apiGet(request as any, `/api/v1/trends/batch?ids=${ids.map(encodeURIComponent).join(',')}`);
        if (!isTransient(resp.status())) recordApi('trends-success', '200 + trends map + missing[]', resp, resp.status() === 200 && data?.version === 'fni_v2.0' && !!data?.trends && typeof data.trends === 'object' && Array.isArray(data?.missing), { retries });
        else recordApi('trends-success', '200', resp, false, { retries });
        const { resp: bad } = await shapedFetch(request as any, 'GET', '/api/v1/trends/batch');
        recordApi('trends-invalid-400', '400 on missing ids', bad, bad.status() === 400);
    });

    test('openapi.json: 200 + 10 declared public paths match live surface (P-05) [API:openapi]', async ({ request }) => {
        const { resp, data } = await apiGet(request as any, '/openapi.json');
        const declared = data?.paths ? Object.keys(data.paths) : [];
        const expectedPaths = ['/api/v1/select', '/api/v1/search', '/api/v1/compare', '/api/v1/badge/{umid}', '/api/v1/entity/{id}', '/api/v1/health', '/api/v1/datasets', '/api/v1/concepts', '/api/v1/trends/batch', '/api/mcp'];
        const allDeclared = expectedPaths.every((p) => declared.includes(p));
        recordApi('openapi-parity', '10 declared public paths incl concepts + trends/batch', resp, resp.status() === 200 && allDeclared, { keyFields: { declaredCount: declared.length, missing: expectedPaths.filter((p) => !declared.includes(p)) } });
        const cmpSem = compareSemanticNullable(data);
        const searchLimitMax = resp.status() === 200 ? findLimitMax(data) : undefined;
        record({ assertion: 'openapi-nullability', expected: 'compare.semantic nullable + search limit max=20', actual: `semanticNullable=${cmpSem} limitMax=${searchLimitMax}`, state: cmpSem === true && searchLimitMax === 20 ? 'PASS' : (resp.status() === 200 ? 'PRODUCT_FAILURE' : 'INCONCLUSIVE_TRANSIENT'), keyFields: { cmpSem, searchLimitMax } });
    });
}
