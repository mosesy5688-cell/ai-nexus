/**
 * OBS-1 — reliability probe coverage tests (no network, fixtures/fakes only; spawns nothing).
 *
 * Locks (hub v116 §3 o1/o3, v117 §3 s1-s3, v118 §3 A/B):
 *   (i)   a GET /ranking target with status_200 + a SOURCE-DECLARED (not measured) h1
 *         marker `AI Ecosystem Rankings` + the (iii) truncation assertion;
 *   (iii) `body_complete_html` on homepage AND /ranking, read from the target's RECORD
 *         only (body_complete / body_suffix_base64 / headers_received), six-rule order;
 *   rec is the FOURTH assert argument, read-only; existing targets' assertion results
 *   are unchanged by the extra argument (regression pin). Missing evidence -> UNKNOWN.
 * Split from the two existing 250-line probe test files for the CES line ceiling.
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore — JS ESM helper module (no .d.ts); tested for its runtime contract.
import * as core from '../../scripts/monitoring/reliability-probe-core.mjs';

const { buildTargetSpecs, runTarget, classifyState, bodyCompleteHtml, HOMEPAGE_MARKER, RANKING_MARKER } = core as any;
const spec = (n: string) => buildTargetSpecs().find((s: any) => s.name === n);
const run = (n: string, deps: any) => runTarget(spec(n), { baseUrl: 'https://x.test', ctx: {}, ...deps });
const hdrs = { get: () => null };
const b64 = (s: string) => Buffer.from(s, 'latin1').toString('base64');
const bytes = (s: string) => new TextEncoder().encode(s);
const streamed = (body: string, status = 200) => async () => {
    let done = false;
    return { status, headers: hdrs, body: { getReader: () => ({ read: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: bytes(body) })) }) } };
};
const whole = (body: string, status = 200) => async () => ({ status, headers: hdrs, text: async () => body });
const oks = (rec: any) => rec.assertions.map((a: any) => [a.name, a.ok]);
const RANK_OK = `<html><h1>${RANKING_MARKER}</h1></html>`;
const HOME_OK = `<html><title>${HOMEPAGE_MARKER}</title></html>`;
const R = (o: any) => ({ headers_received: true, body_complete: true, body_suffix_base64: b64('</body></html>'), ...o });

describe('constants + the /ranking target table entry', () => {
    it('RANKING_MARKER is the source-declared h1 literal; /ranking is GET, ordered after homepage', () => {
        expect(RANKING_MARKER).toBe('AI Ecosystem Rankings'); // independent literal
        const names = buildTargetSpecs().map((s: any) => s.name);
        expect(names).toEqual(['health', 'search', 'entity', 'invalid_id_404', 'openapi', 'homepage', 'ranking',
            'mcp_initialize', 'mcp_tools_list', 'index_coherence']);
        expect([spec('ranking').method, spec('ranking').path]).toEqual(['GET', '/ranking']);
        // v118 §3 A: only homepage and ranking declare the 4th (rec) parameter.
        const four = buildTargetSpecs().filter((s: any) => s.assert.length === 4).map((s: any) => s.name);
        expect(four).toEqual(['homepage', 'ranking']);
    });
});

describe('body_complete_html — locked six-rule order (v118 §3 B), one test per rule', () => {
    const THREE = [true, false, null];
    it('rule 1: rec missing (not an object) -> null', () => {
        for (const r of [undefined, null, 'rec', 42]) expect(bodyCompleteHtml(r)).toBe(null);
    });
    it('rule 2: headers_received !== true -> null, even with a complete </html> suffix', () => {
        for (const h of [false, undefined, 'true']) expect(bodyCompleteHtml(R({ headers_received: h }))).toBe(null);
    });
    it('rule 3: body_complete === false -> false, beating null (overlap case: suffix null)', () => {
        expect(bodyCompleteHtml(R({ body_complete: false, body_suffix_base64: null }))).toBe(false);
        expect(bodyCompleteHtml(R({ body_complete: false }))).toBe(false); // suffix even has </html>
    });
    it('rule 4: complete + decoded suffix contains </html> -> true', () => {
        expect(bodyCompleteHtml(R({}))).toBe(true);
        expect(bodyCompleteHtml(R({ body_suffix_base64: b64('</html>') }))).toBe(true);
    });
    it('rule 5: complete + suffix null OR lacking </html> -> false', () => {
        expect(bodyCompleteHtml(R({ body_suffix_base64: null }))).toBe(false);
        expect(bodyCompleteHtml(R({ body_suffix_base64: b64('<html><body>cut mid-stre') }))).toBe(false);
        expect(bodyCompleteHtml(R({ body_suffix_base64: b64('</HTML>') }))).toBe(false); // exact literal
    });
    it('rule 6: anything else -> null (never a fourth value)', () => {
        expect(bodyCompleteHtml(R({ body_complete: undefined }))).toBe(null);
        expect(bodyCompleteHtml(R({ body_complete: 'yes' }))).toBe(null);
        expect(bodyCompleteHtml(R({ body_suffix_base64: 42 }))).toBe(null);
        for (const r of [undefined, R({}), R({ body_complete: false }), R({ body_complete: 1 })]) expect(THREE).toContain(bodyCompleteHtml(r));
    });
});

describe('missing evidence -> UNKNOWN, never PASS', () => {
    it('a null truncation verdict with every other assertion held classifies UNKNOWN', () => {
        for (const n of ['homepage', 'ranking']) {
            const body = n === 'homepage' ? HOME_OK : RANK_OK;
            const list = spec(n).assert({ status: 200 }, body, {}, undefined); // no rec = missing evidence
            expect(list.map((a: any) => a.ok)).toEqual([true, true, null]);
            expect(classifyState(true, list)).toBe('UNKNOWN');
        }
    });
    it('ranking: body released on retention overflow -> marker NAMED null -> UNKNOWN', async () => {
        const rec = await run('ranking', { maxAssertionBodyBytes: 8, fetchImpl: streamed(RANK_OK) });
        expect([rec.assertion_body_overflowed, rec.state, rec.failure_phase]).toEqual([true, 'UNKNOWN', null]);
        expect(oks(rec)).toEqual([['status_200', true], ['ranking_marker', null], ['body_complete_html', true]]);
    });
});

describe('discrimination — deleting either new assertion turns a FAIL below into a PASS', () => {
    it('ranking: marker + </html> -> PASS on both read paths; exact assertion list', async () => {
        for (const impl of [streamed(RANK_OK), whole(RANK_OK)]) {
            const rec = await run('ranking', { fetchImpl: impl });
            expect([rec.state, rec.url]).toEqual(['PASS', 'https://x.test/ranking']);
            expect(oks(rec)).toEqual([['status_200', true], ['ranking_marker', true], ['body_complete_html', true]]);
        }
    });
    it('ranking: complete </html> page WITHOUT the marker -> FAIL (ranking_marker)', async () => {
        const rec = await run('ranking', { fetchImpl: streamed('<html><h1>Something else</h1></html>') });
        expect([rec.state, rec.failure_phase]).toEqual(['FAIL', 'assertion']);
        expect(oks(rec)).toEqual([['status_200', true], ['ranking_marker', false], ['body_complete_html', true]]);
    });
    it('ranking: marker present but body never closes </html> -> FAIL (body_complete_html)', async () => {
        const rec = await run('ranking', { fetchImpl: streamed(`<html><h1>${RANKING_MARKER}</h1><div>cut`) });
        expect([rec.state, rec.failure_phase]).toEqual(['FAIL', 'assertion']);
        expect(oks(rec)).toEqual([['status_200', true], ['ranking_marker', true], ['body_complete_html', false]]);
    });
    it('homepage: marker present but no </html> -> FAIL; with </html> -> PASS', async () => {
        const bad = await run('homepage', { fetchImpl: whole(`<html><title>${HOMEPAGE_MARKER}</title>`) });
        const good = await run('homepage', { fetchImpl: whole(HOME_OK) });
        expect([bad.state, good.state]).toEqual(['FAIL', 'PASS']);
        expect(oks(bad)).toEqual([['status_200', true], ['home_contract_marker', true], ['body_complete_html', false]]);
    });
    it('ranking: non-200 -> FAIL (status_200)', async () => {
        const rec = await run('ranking', { fetchImpl: streamed(RANK_OK, 524) });
        expect([rec.state, rec.assertions[0].ok]).toEqual(['FAIL', false]);
    });
});

describe('Z-5 — the truncation verdict is read from the RECORD, not the assertion body', () => {
    it('direct: body says </html> but rec suffix does not -> false; and the converse -> true', () => {
        for (const n of ['homepage', 'ranking']) {
            const a = spec(n).assert({ status: 200 }, '</html>', {}, R({ body_suffix_base64: b64('no close') }));
            const b = spec(n).assert({ status: 200 }, 'no close', {}, R({ body_suffix_base64: b64('</html>') }));
            expect([a[2].ok, b[2].ok]).toEqual([false, true]);
        }
    });
    it('runtime: suffix written by finalize (bounded edge) decides, on BOTH read paths', async () => {
        // bodyEdgeBytes 7: the retained suffix is the last 7 bytes. `</html>` inside the
        // body but NOT at its tail is invisible to the suffix -> false, though the full
        // body handed to the other assertions still contains it.
        const tailJunk = `${RANK_OK}<!--x-->`;
        for (const mk of [streamed, whole]) {
            const ok = await run('ranking', { bodyEdgeBytes: 7, fetchImpl: mk(RANK_OK) });
            const junk = await run('ranking', { bodyEdgeBytes: 7, fetchImpl: mk(tailJunk) });
            expect([ok.body_complete, Buffer.from(ok.body_suffix_base64, 'base64').toString(), ok.state]).toEqual([true, '</html>', 'PASS']);
            expect([junk.body_complete, junk.state, oks(junk)[1][1], oks(junk)[2][1]]).toEqual([true, 'FAIL', true, false]);
        }
    });
    it('rec is read-only: a FROZEN record is accepted and yields the same verdict', () => {
        for (const n of ['homepage', 'ranking']) {
            const r = R({}); const frozen = Object.freeze({ ...r });
            expect(spec(n).assert({ status: 200 }, 'x', {}, frozen)).toEqual(spec(n).assert({ status: 200 }, 'x', {}, r));
            expect(r).toEqual(R({})); // not mutated
        }
    });
});

describe('regression pin — existing targets are unchanged by the extra (4th) argument', () => {
    const REC = R({});
    const CASES: Array<[string, any, any, any]> = [
        ['health', 200, '{"manifest_state":"loaded","served_build_id":"b1"}', {}],
        ['search', 200, '{"results":[{"id":"e1"}]}', {}],
        ['entity', 200, '{"entity":{"id":"e1"}}', { entity_id: 'e1' }],
        ['entity', 200, '{}', { entity_id: 'e1' }],
        ['invalid_id_404', 404, '', {}],
        ['openapi', 200, '{"openapi":"3.0.3"}', {}],
        ['openapi', 200, 'not json', {}],
        ['mcp_initialize', 200, '{"result":{"serverInfo":{"name":"f2ai"}}}', {}],
        ['mcp_tools_list', 200, '{"result":{"tools":[]}}', {}],
        ['index_coherence', 200, null, { served_build_id: 'b1' }],
    ];
    it('each non-homepage existing spec: identical assertion list AND ctx effect with / without rec', () => {
        for (const [n, status, body, ctx0] of CASES) {
            const c3 = { ...ctx0 }; const c4 = { ...ctx0 };
            const three = spec(n).assert({ status }, body, c3);
            const four = spec(n).assert({ status }, body, c4, REC);
            expect([n, four]).toEqual([n, three]);
            expect([n, c4]).toEqual([n, c3]);
        }
    });
    it('homepage: pre-existing two assertions identical; only body_complete_html is appended', () => {
        for (const body of [HOME_OK, '<html>maintenance</html>', null]) {
            const three = spec('homepage').assert({ status: 200 }, body, {});
            const four = spec('homepage').assert({ status: 200 }, body, {}, REC);
            expect(four.slice(0, 2)).toEqual(three.slice(0, 2));
            expect(four.map((a: any) => a.name)).toEqual(['status_200', 'home_contract_marker', 'body_complete_html']);
        }
    });
    it('runTarget passes the target record itself as the 4th argument (call site :567 at base)', async () => {
        let seen: any = 'unset'; let arity = -1;
        const probe = { name: 'p', method: 'GET', path: '/', assert: (...args: any[]) => { arity = args.length; seen = args[3]; return [{ name: 'x', ok: true }]; } };
        const rec = await runTarget(probe, { baseUrl: 'https://x.test', ctx: {}, fetchImpl: whole('</html>') });
        expect([arity, seen === rec, seen.target]).toEqual([4, true, 'p']);
    });
});
