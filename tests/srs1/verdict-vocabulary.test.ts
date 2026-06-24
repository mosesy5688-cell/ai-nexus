/**
 * SRS-1 — FD-16 / C0-CH-001 verdict-vocabulary invariant (tier-1, hermetic).
 *
 * NORTH STAR (Founder): "we do not judge truth on behalf of the AI; we deliver
 * the cleanest evidence chain." The FINAL-RATIFIED Page Messaging Contract (Sec 5)
 * FORBIDS the machine surfaces from emitting a SELECTION VERDICT vocabulary on the
 * /api/v1/select + MCP select_model + served OpenAPI surface:
 *   - NO `recommendations` response key   (the wire array is the neutral `entries`)
 *   - NO `confidence` field/scalar        (a synthetic per-entity confidence is a verdict;
 *                                          signal strength already lives in the FNI fields/badge)
 *   - NO "best AI model" claim
 *   - NO "ranked recommendations" claim
 *   - NO "selected"/"selects"-as-verdict claim
 * and the select_model tool MUST state, in substance, that the CALLER makes the
 * final choice (a discovery layer, not a decider).
 *
 * This is the POSITIVE-VOCABULARY ABSENCE lock. It is the complement of NEG-MCP /
 * NEG-RANK / NEG-DOCS (which assert the NOT-section is PRESENT): those guard that
 * the boundary is stated; THIS guards that the forbidden verdict tokens never
 * reappear in the select/MCP/OpenAPI machine contract (a regression that the
 * present-NOT-section test alone would not catch — a surface can carry the
 * NOT-section AND still leak a `recommendations` key or a `confidence` scalar).
 *
 * HERMETIC: reads SOURCE of select.ts / rationale-builder.ts / mcp.ts /
 * mcp-select.ts and parses the static mcp.json + openapi-schema.json. The
 * comment/doc blocks of the .ts sources (which legitimately NAME the banned tokens
 * as banned, e.g. "no pseudo-confidence") are STRIPPED before the absence scan so
 * the guard tests the CODE/STRINGS, never the prose that documents the ban. No
 * module execution, no `cloudflare:workers` import, no live fetch. Deterministic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);

// Strip block + line comments so a doc block that NAMES a banned token as banned
// (e.g. "No pseudo-confidence", "no selection/verdict/recommendation") does not
// false-trip the absence scan. We test the executable code + emitted strings.
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (keep "://" in urls)
}

const mcpJson = require('../../public/.well-known/mcp.json');
const schema = require('../../src/data/openapi-schema.json');

const SELECT_SRC = stripComments(read('src/pages/api/v1/select.ts'));
const RATIONALE_SRC = stripComments(read('src/lib/rationale-builder.ts'));
const MCP_SRC = read('src/pages/api/mcp.ts');
const MCP_SELECT_SRC = stripComments(read('src/lib/mcp-select.ts'));

// The select_model tool description string, extracted from the mcp.ts TOOLS array.
function selectToolDescriptionFromHandler(): string {
    const i = MCP_SRC.indexOf("name: 'free2aitools_select_model'");
    expect(i, 'mcp.ts must declare free2aitools_select_model').toBeGreaterThan(-1);
    const m = MCP_SRC.slice(i).match(/description:\s*'((?:[^'\\]|\\.)*)'/);
    expect(m, 'select_model tool must carry a description string').toBeTruthy();
    return m![1];
}

function selectToolDescriptionFromStatic(): string {
    const tool = mcpJson.tools.find((t: any) => t.name === 'free2aitools_select_model');
    expect(tool, 'mcp.json must list free2aitools_select_model').toBeTruthy();
    return tool.description as string;
}

// The served OpenAPI select path description + the SelectResponse/Entry schemas.
const SELECT_PATH = schema.paths['/api/v1/select'].post;
const SELECT_RESP = schema.components.schemas.SelectResponse.properties;
const ENTRY_PROPS = schema.components.schemas.Entry.properties;

// Forbidden POSITIVE verdict tokens. Each is a tolerant matcher: "best AI model",
// "ranked recommendations", a `recommendations` response KEY, a `confidence`
// field/scalar, a "selected"/"selects" verdict. The negative disclaimer forms
// ("does NOT perform task-fit recommendation", "no selection/verdict") are
// permitted — those are scoped out below by stripping comments AND by only
// rejecting the AFFIRMATIVE constructions in prose surfaces.
const RECOMMENDATIONS_KEY = /['"]recommendations['"]\s*:/; // a JSON/object recommendations KEY
const CONFIDENCE_TOKEN = /confidence/i; // synthetic confidence anywhere (field or prose)
const BEST_AI_MODEL = /\bbest\s+ai\s+model\b/i;
const RANKED_RECOMMENDATIONS = /ranked\s+recommendations?/i;

describe('SRS-1 FD-16 (T1): /api/v1/select wire shape carries NO forbidden verdict keys', () => {
    it('select.ts response object uses `entries`, never a `recommendations` key', () => {
        // The returned JSON literal is `{ version, task_interpreted, total_candidates, entries, meta }`.
        expect(SELECT_SRC).toMatch(/\bentries\b/);
        expect(SELECT_SRC).not.toMatch(RECOMMENDATIONS_KEY);
        // No bare `recommendations` identifier emitted into the payload either.
        expect(SELECT_SRC).not.toMatch(/\brecommendations\b/);
    });
    it('select.ts emits NO `confidence` field/scalar (no synthetic per-entity confidence)', () => {
        expect(SELECT_SRC).not.toMatch(CONFIDENCE_TOKEN);
    });
    it('select.ts RETAINS the honest evidence fields (fni_summary, caveats, fni_factors)', () => {
        expect(SELECT_SRC).toMatch(/\bfni_summary\b/);
        expect(SELECT_SRC).toMatch(/\bcaveats\b/);
        expect(SELECT_SRC).toMatch(/\bfni_factors\b/);
    });
    it('endpoint path is unchanged: /api/v1/select is the select handler route', () => {
        // The route file lives at src/pages/api/v1/select.ts (filesystem-routed),
        // and the OpenAPI declares exactly that path.
        expect(schema.paths['/api/v1/select']).toBeTruthy();
        expect(SELECT_PATH.operationId).toBe('selectModel');
    });
});

describe('SRS-1 FD-16 (T2): rationale-builder produces evidence facts, NO confidence', () => {
    it('RationaleResult shape is { fni_summary, caveats } — no confidence producer', () => {
        expect(RATIONALE_SRC).toMatch(/fni_summary/);
        expect(RATIONALE_SRC).toMatch(/caveats/);
        // No `confidence` identifier/field is produced anywhere in the code.
        expect(RATIONALE_SRC).not.toMatch(CONFIDENCE_TOKEN);
    });
});

describe('SRS-1 FD-16 (T3): MCP select_model tool description carries NO forbidden vocabulary', () => {
    for (const [where, getDesc] of [
        ['mcp.ts handler', selectToolDescriptionFromHandler],
        ['static mcp.json', selectToolDescriptionFromStatic],
    ] as const) {
        it(`${where}: no "best AI model" / "ranked recommendations" / "confidence" / bare verdict`, () => {
            const desc = getDesc();
            expect(desc).not.toMatch(BEST_AI_MODEL);
            expect(desc).not.toMatch(RANKED_RECOMMENDATIONS);
            expect(desc).not.toMatch(CONFIDENCE_TOKEN);
            // "selected"/"selects" as a positive verdict ("why each was SELECTED").
            // The neutral "selection" only appears in the caller-decides clause, which
            // is asserted separately below; an affirmative "we selected/select X" is banned.
            expect(desc).not.toMatch(/\b(we|each\w*)\s+\w*\s*selecte?d?\b/i);
            // No affirmative "recommends"/"recommendation(s)" claim. The permitted
            // form is the NEGATIVE disclaimer "does not ... recommend"; assert any
            // "recommend" occurrence is negated.
            const recIdx = desc.toLowerCase().indexOf('recommend');
            if (recIdx > -1) {
                const ctx = desc.slice(Math.max(0, recIdx - 40), recIdx + 12).toLowerCase();
                expect(ctx, `"recommend" in select_model desc must be negated (${where})`).toMatch(
                    /\b(not|no|never)\b/,
                );
            }
        });
        it(`${where}: states the CALLER makes the final choice (discovery, not decider)`, () => {
            const desc = getDesc();
            expect(desc).toMatch(/caller is responsible for (the )?final (model )?selection|caller (makes|decides)/i);
        });
    }
});

describe('SRS-1 FD-16 (T4): mcp-select.ts passes the 200 body through unchanged (adds no verdict)', () => {
    it('buildSelectResult emits the select JSON verbatim — no injected recommendation/confidence', () => {
        // The 200 path stringifies res.data unchanged; the only synthesized text is
        // the transient 503 retry message. Neither path introduces a forbidden token.
        expect(MCP_SELECT_SRC).not.toMatch(RECOMMENDATIONS_KEY);
        expect(MCP_SELECT_SRC).not.toMatch(CONFIDENCE_TOKEN);
        expect(MCP_SELECT_SRC).not.toMatch(BEST_AI_MODEL);
    });
});

describe('SRS-1 FD-16 (T5): served OpenAPI select contract carries NO forbidden vocabulary', () => {
    it('SelectResponse top-level uses `entries`, declares NO `recommendations`', () => {
        expect(SELECT_RESP.entries).toBeTruthy();
        expect(SELECT_RESP.recommendations).toBeUndefined();
    });
    it('Entry schema declares NO `confidence` property; retains fni_summary/caveats/fni_factors', () => {
        expect(ENTRY_PROPS.confidence).toBeUndefined();
        expect(ENTRY_PROPS.fni_summary).toBeTruthy();
        expect(ENTRY_PROPS.caveats).toBeTruthy();
        expect(ENTRY_PROPS.fni_factors).toBeTruthy();
    });
    it('select path + Entry descriptions carry no "best AI model"/"ranked recommendations"/confidence', () => {
        const blob = JSON.stringify({
            path: SELECT_PATH.description,
            resp: SELECT_RESP,
            entry: ENTRY_PROPS,
        });
        expect(blob).not.toMatch(BEST_AI_MODEL);
        expect(blob).not.toMatch(RANKED_RECOMMENDATIONS);
        expect(blob).not.toMatch(CONFIDENCE_TOKEN);
        // The select path description states the caller decides (verdict-free).
        expect(SELECT_PATH.description).toMatch(/caller is responsible for (the )?final (model )?selection/i);
    });
    it('static mcp.json select_model carries no forbidden vocabulary in its description', () => {
        const desc = selectToolDescriptionFromStatic();
        expect(desc).not.toMatch(BEST_AI_MODEL);
        expect(desc).not.toMatch(RANKED_RECOMMENDATIONS);
        expect(desc).not.toMatch(CONFIDENCE_TOKEN);
    });
});

describe('SRS-1 FD-16 (T6): tool identifier + endpoint path are unchanged (no capability drift)', () => {
    it('MCP tool identifier remains exactly `free2aitools_select_model`', () => {
        expect(MCP_SRC).toMatch(/name:\s*'free2aitools_select_model'/);
        expect(mcpJson.tools.some((t: any) => t.name === 'free2aitools_select_model')).toBe(true);
    });
    it('OpenAPI select endpoint path remains exactly `/api/v1/select`', () => {
        expect(Object.keys(schema.paths)).toContain('/api/v1/select');
    });
});
