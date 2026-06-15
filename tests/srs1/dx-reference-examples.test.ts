/**
 * SRS-1 / P3-DX-1 — Developer-journey reference-example invariants, static tier
 * (tier-1, hermetic). Behavioral execution (R5 JS / R6 Python) lives in the
 * companion `dx-reference-behavior.test.ts`.
 *
 * GOAL: a COLD developer can complete a first integration from the public docs
 * with no internal knowledge. This guard locks the shipped reference examples in
 * /developers (+ the machine surfaces that point at them) against the failure
 * modes that broke that promise: stale fixed catalog ids, fixed-id-dependent
 * primary examples, missing search-first dependency, missing route links, and
 * decision/router language that violates the caller-decides contract.
 *
 * R1 retired-id absence | R2 search-derived dependency | R3 route/link presence
 * R4 exact-snippet extraction | R7 workflow boundary.
 * R8 SRS-1 registration: tracked in INVARIANT_REGISTRY.md (P3-DX-1 section).
 *
 * HERMETIC: reads SOURCE/CONFIG and the snippets extracted from developers.astro
 * (no test-only rewrites). No live fetch. Deterministic across runs.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, DEV, README, LLMS, MCP, curlSnippet, jsSnippet, pySnippet } from './dx-snippet-extract';

// --- R1: retired-id absence -------------------------------------------------
// Stale forms that must NOT appear in any executable example or machine field.
const STALE_IDS = [
  'meta-llama/Llama-3-8B-Instruct',
  'hf-model--meta-llama--llama-3-8b',
  'meta-llama/Llama-3-8B',
  'hf-model--meta-llama--Llama-3-8B-Instruct',
  'meta-llama--Llama-3-8B-Instruct',
  'gemma-2-27b',
  'llama-3.3-70b-instruct',
  'deepseek-v3',
  'gemma-4-31b-it-nvfp4',
];

describe('R1: no retired/stale catalog ids in shipped executable/machine fields', () => {
  const surfaces: Array<[string, string]> = [
    ['developers.astro', DEV],
    ['README.md', README],
    ['llms-template.txt', LLMS],
    ['mcp.json', MCP],
  ];
  for (const [label, body] of surfaces) {
    for (const stale of STALE_IDS) {
      it(`${label} contains no stale id "${stale}"`, () => {
        expect(body.includes(stale), `${label} still references ${stale}`).toBe(false);
      });
    }
  }
});

// --- R2: search-derived dependency ------------------------------------------
describe('R2: primary entity/compare examples are search-derived, not fixed-id', () => {
  it('curl snippet searches before it inspects/compares and derives ids from results', () => {
    expect(curlSnippet).toMatch(/\/api\/v1\/search/);
    expect(curlSnippet).toMatch(/\.results\[\]\.id/); // jq derives ids from the response
    expect(curlSnippet).toMatch(/entity\/\$ID_ENC/);
    expect(curlSnippet).toMatch(/compare\?ids=\$\{IDS\[0\]\},\$\{IDS\[1\]\}/);
  });
  it('JS snippet derives ids from results and uses them downstream', () => {
    expect(jsSnippet).toMatch(/\/api\/v1\/search/);
    expect(jsSnippet).toMatch(/results\.map\(\(r\) => r\.id\)/);
    expect(jsSnippet).toMatch(/entity\/\$\{encodeURIComponent\(ids\[0\]\)\}/);
    expect(jsSnippet).toMatch(/compare\?ids=\$\{ids\[0\]\},\$\{ids\[1\]\}/);
  });
  it('Python snippet derives ids from results and uses them downstream', () => {
    expect(pySnippet).toMatch(/\/api\/v1\/search/);
    expect(pySnippet).toMatch(/r\.get\("id"\) for r in results/);
    expect(pySnippet).toMatch(/entity\/\{requests\.utils\.quote\(ids\[0\]/);
    expect(pySnippet).toMatch(/compare\?ids=\{ids\[0\]\},\{ids\[1\]\}/);
  });
  it('fixed-id forms in docs are explicitly marked as templates/placeholders', () => {
    expect(DEV).toMatch(/Grammar templates only/);
    expect(DEV).toMatch(/&lt;ID_FROM_SEARCH&gt;/);
    expect(DEV).toMatch(/Illustrative response/);
  });
});

// --- R3: route/link presence ------------------------------------------------
describe('R3: documented routes exist in the contract/route inventory', () => {
  const requireRoutes: Array<[string, string]> = [
    ['/openapi.json', 'src/pages/openapi.json.ts'],
    ['/api/v1/search', 'src/pages/api/v1/search.ts'],
    ['/api/v1/compare', 'src/pages/api/v1/compare.ts'],
    ['/api/v1/entity/{id}', 'src/pages/api/v1/entity/[...id].ts'],
    ['/.well-known/mcp.json', 'public/.well-known/mcp.json'],
    ['/api/mcp', 'src/pages/api/mcp.ts'],
  ];
  for (const [label, file] of requireRoutes) {
    it(`${label} route/contract file exists`, () => {
      expect(existsSync(resolve(root, file)), `${file} missing`).toBe(true);
    });
  }
  it('/developers links to /openapi.json (orphan-openapi fix DJ-D01)', () => {
    expect(DEV).toMatch(/href="\/openapi\.json"/);
  });
  it('llms.txt template points at /openapi.json and /developers (DJ-D01)', () => {
    expect(LLMS).toMatch(/\/openapi\.json/);
    expect(LLMS).toMatch(/\/developers/);
  });
  it('README links to /developers', () => {
    expect(README).toMatch(/free2aitools\.com\/developers/);
  });
});

// --- R4: exact-snippet extraction sanity ------------------------------------
describe('R4: snippets are the exact ones shipped in developers.astro', () => {
  it('curl/JS/Python snippets are present with markers + configurable base URL', () => {
    expect(curlSnippet).toContain('#!/usr/bin/env bash');
    expect(jsSnippet).toContain('Node 18+ (built-in fetch)');
    expect(pySnippet).toContain('python -m pip install requests');
    expect(curlSnippet).toMatch(/F2AI_BASE/);
    expect(jsSnippet).toMatch(/process\.env\.F2AI_BASE/);
    expect(pySnippet).toMatch(/os\.environ\.get\("F2AI_BASE"/);
  });
});

// --- R7: workflow boundary --------------------------------------------------
describe('R7: no autonomous-decision/router language in the new flow', () => {
  const FORBIDDEN = [
    /\bwe (recommend|choose|select|decide)\b/i,
    /\b(routes?|routing) (your|the) (model|request)\b/i,
    /\bbest model for you\b/i,
    /\bautomatically (selects?|chooses?|decides?)\b/i,
    /\bmakes the final (decision|selection) for you\b/i,
  ];
  const newFlow = curlSnippet + '\n' + jsSnippet + '\n' + pySnippet;
  for (const pat of FORBIDDEN) {
    it(`snippets do not use decision/router phrasing ${pat}`, () => {
      expect(newFlow).not.toMatch(pat);
    });
  }
  it('the flow restates caller-decides explicitly', () => {
    expect(curlSnippet).toMatch(/does not decide for you/i);
    expect(jsSnippet).toMatch(/caller.*makes the final choice/i);
    expect(pySnippet).toMatch(/caller.*makes the final choice/i);
  });
  it('REST-vs-MCP chooser is neutral (no MCP-preferred / REST-legacy / F2AI-routes)', () => {
    expect(DEV).not.toMatch(/prefer mcp/i);
    expect(DEV).not.toMatch(/\blegacy\b/i);
    expect(DEV).not.toMatch(/free2ai (routes|decides which)/i);
    expect(LLMS).not.toMatch(/prefer mcp/i);
  });
});
