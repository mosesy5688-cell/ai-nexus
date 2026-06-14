/**
 * SRS-1 — North-Star negative-contract invariant (tier-1, hermetic).
 *
 * NORTH STAR (Founder): "we do not judge truth on behalf of the AI; we deliver
 * the cleanest evidence chain." The product surfaces must carry an explicit
 * NOT-section that scopes the boundary: the discovery layer does NOT select /
 * decide / recommend on the caller's behalf, and does NOT currently provide
 * live semantic/ANN ranking. This guard locks that negative contract across the
 * four authoritative surfaces, and locks that the un-buyable ranking comparator
 * reads ONLY public structural factors (params_billions + fni_score).
 *
 * HERMETIC: reads SOURCE/CONFIG of mcp.ts, the ranking comparator, the llms.txt
 * template, and developers.astro. No live fetch, no module execution that
 * touches network. Deterministic across runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

// The boundary claims that MUST appear (in spirit) on every surface that
// advertises the API/MCP capability. Each entry is a tolerant matcher so wording
// can evolve without going silent on the contract.
const NOT_SELECT = /does not select or decide|do not select or decide|not select or decide/i;
const NOT_RECOMMEND = /does not (execute|perform).{0,40}recommend|do not (execute|perform).{0,40}recommend|recommend workflows/i;
const NOT_LIVE_SEMANTIC = /not currently provide live semantic\/ANN|live semantic\/ANN ranking is not/i;

describe('SRS-1: mcp.ts SERVER_BOUNDARY carries the NOT-section', () => {
    const src = read('src/pages/api/mcp.ts');
    const boundary = (() => {
        const m = src.match(/const SERVER_BOUNDARY\s*=\s*'([^']*)'/);
        expect(m, 'mcp.ts must define SERVER_BOUNDARY').not.toBeNull();
        return m![1];
    })();

    it('boundary states it does NOT select/decide for the caller', () => {
        expect(boundary).toMatch(NOT_SELECT);
    });
    it('boundary states it does NOT execute/plan/recommend workflows', () => {
        expect(boundary).toMatch(NOT_RECOMMEND);
    });
    it('boundary states NO live semantic/ANN ranking', () => {
        expect(boundary).toMatch(NOT_LIVE_SEMANTIC);
    });
    it('boundary is surfaced as MCP initialize.instructions', () => {
        // POST initialize returns instructions: SERVER_BOUNDARY — the Agent reads it.
        expect(src).toMatch(/instructions:\s*SERVER_BOUNDARY/);
    });
});

describe('SRS-1: select_model transient 503 maps to an isError tool result (G-05)', () => {
    // The negative contract must not be laundered: a transient 503 surfaces as an
    // honest retryable isError, never a fake-success tool result. Source-asserted
    // on the shared mapping module so the runtime path is the one under guard.
    const src = read('src/lib/mcp-select.ts');
    it('buildSelectResult maps status 503 -> isError: true', () => {
        expect(src).toMatch(/res\.status\s*===?\s*503/);
        expect(src).toMatch(/isError:\s*true/);
    });
});

describe('SRS-1: ranking comparator reads ONLY params_billions + fni_score', () => {
    // C4 / North-Star: order derives purely from public structural factors. The
    // comparator must not read any payment/sponsor/tier signal. (Behavioural proof
    // lives in c4-anti-arbitration.test.ts; this is the static field-scope lock.)
    const src = read('src/lib/ranking-order.ts');
    it('the only row fields the comparator reads are params_billions + fni_score', () => {
        const reads = [...src.matchAll(/row\??\.(\w+)/g)].map((m) => m[1]);
        const distinct = [...new Set(reads)].sort();
        expect(distinct).toEqual(['fni_score', 'params_billions']);
    });
    it('no payment/sponsor/tier signal token appears in the comparator interface or body', () => {
        // Scope to the code that defines the RankableRow shape + comparator fns,
        // excluding the doc block that explicitly NAMES the banned tokens as banned.
        const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '');
        for (const banned of [/\bsponsor/i, /\bpaid\b/i, /\btier\b/i, /\bpromoted\b/i, /\bbid\b/i, /\bbilling\b/i]) {
            expect(code, `comparator code must not read ${banned}`).not.toMatch(banned);
        }
    });
});

describe('SRS-1: public docs (llms.txt + developers) carry the NOT-section', () => {
    it('llms-template.txt carries the full NOT-section', () => {
        const t = read('src/data/llms-template.txt');
        expect(t).toMatch(NOT_SELECT);
        expect(t).toMatch(/Does NOT (execute, plan, or recommend|perform compatibility)/i);
        expect(t).toMatch(NOT_LIVE_SEMANTIC);
    });
    it('developers.astro carries the discovery-layer NOT-section', () => {
        const d = read('src/pages/developers.astro');
        expect(d).toMatch(NOT_SELECT);
        expect(d).toMatch(NOT_LIVE_SEMANTIC);
        expect(d).toMatch(/do not execute\/plan\/recommend workflows/i);
    });
});
