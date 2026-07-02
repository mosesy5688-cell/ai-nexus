/**
 * SDK public-surface sync invariant (SDK-SURFACE, Founder D-221).
 *
 * `@free2aitools/sdk@0.1.0` is published + registry-verified on npm. This is a
 * NARROW, factual public-documentation correction (an INITIAL PUBLIC RELEASE,
 * NOT GA / not an adoption claim). These hermetic locks pin the corrected public
 * surfaces to the truthful state so they cannot silently drift back to
 * "No SDK, no dependencies" and so no over-claim (GA / production-proven /
 * adopted / paid) can be introduced.
 *
 * Hermetic: reads repo SOURCE/CONFIG only (developers page, homepage integration
 * component, index meta, llms.txt template) + cross-checks the REAL published SDK
 * source (packages/sdk/src) so the example-uses-real-exports lock is non-vacuous.
 * No live network, no module execution, deterministic.
 *
 * The 10 regression locks (D-221 §I):
 *  1. exact phrase "No SDK, no dependencies" ABSENT from the developers page
 *  2. `@free2aitools/sdk` appears on /developers
 *  3. `npm install @free2aitools/sdk` appears on /developers
 *  4. version 0.1.0 presented as an initial public release (not GA)
 *  5. the example imports only REAL published exports (Free2AIClient / search)
 *  6. SDK, REST and MCP all present as valid integration paths
 *  7. homepage SDK entry exists OUTSIDE the frozen hero/meta content
 *  8. llms.txt carries the SDK package + docs pointer
 *  9. no forbidden claim (GA / production-proven / adopted / paid) is present
 * 10. documentation-only: the REST endpoint set + the 5 MCP tools are unchanged
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const DEV = read('src/pages/developers.astro');
const HOME = read('src/components/home/HomeTechnicalHeader.astro');
const INDEX = read('src/pages/index.astro');
const LLMS = read('src/data/llms-template.txt');
const SDK_INDEX = read('packages/sdk/src/index.ts');
const SDK_CLIENT = read('packages/sdk/src/client.ts');

const PKG = '@free2aitools/sdk';
const INSTALL = 'npm install @free2aitools/sdk';

// D-221 §H forbidden language. Each scanned against the three edited public
// surfaces. `\bGA\b` is case-sensitive (uppercase acronym) so lowercase "ga"
// inside ordinary words never false-trips.
const FORBIDDEN: Array<[string, RegExp]> = [
  ['General Availability', /general availability/i],
  ['GA (acronym)', /\bGA\b/],
  ['production-ready', /production[\s-]?ready/i],
  ['production-proven', /production[\s-]?proven/i],
  ['stable API guarantee', /stable\s+api\s+guarantee/i],
  ['1.0 compatibility', /1\.0\s+compatibility/i],
  ['widely adopted', /widely\s+adopted/i],
  ['used by Agents', /used\s+by\s+agents/i],
  ['recommended default', /recommended\s+default/i],
  ['replaces REST/MCP', /replaces?\s+(rest|mcp)/i],
  ['provenance verified by npm', /provenance\s+verified\s+by\s+npm/i],
  // paid / commercial claims
  ['subscription', /\bsubscription\b/i],
  ['billing', /\bbilling\b/i],
  ['refund', /\brefund/i],
  ['paid tier', /\bpaid\s+tiers?\b/i],
  ['credit card', /\bcredit\s+card\b/i],
  ['money-back', /money[\s-]?back/i],
  ['payment processor', /\bpayment\s+processor\b/i],
];

describe('SDK-SURFACE 1: stale "No SDK, no dependencies" is gone from /developers', () => {
  it('the exact stale phrase is ABSENT', () => {
    expect(DEV).not.toMatch(/No SDK, no dependencies/i);
  });
  it('the direct-fetch path is still described honestly (no additional dependency)', () => {
    expect(DEV).toMatch(/no additional dependency/i);
  });
});

describe('SDK-SURFACE 2/3: package name + install command on /developers', () => {
  it('the package name is present', () => expect(DEV).toContain(PKG));
  it('the install command is present', () => expect(DEV).toContain(INSTALL));
});

describe('SDK-SURFACE 4: version 0.1.0 as an initial public release (not GA)', () => {
  it('version 0.1.0 is presented', () => expect(DEV).toMatch(/\b0\.1\.0\b/));
  it('framed as an initial public release, adjacent to the version', () => {
    expect(DEV).toMatch(/initial public release[\s\S]{0,120}0\.1\.0/i);
  });
  it('does NOT frame it as GA / General Availability', () => {
    expect(DEV).not.toMatch(/general availability/i);
    expect(DEV).not.toMatch(/\bGA\b/);
  });
});

describe('SDK-SURFACE 5: the example imports only REAL published SDK exports', () => {
  it('imports Free2AIClient from the package', () => {
    expect(DEV).toContain(`import { Free2AIClient } from "${PKG}"`);
  });
  it('calls client.search({ q, limit }) and reads res.results (real shape)', () => {
    expect(DEV).toMatch(/client\.search\(\{\s*q:/);
    expect(DEV).toMatch(/res\.results/);
  });
  it('does NOT call the MCP-only rank()/explain() as SDK/REST methods', () => {
    expect(DEV).not.toMatch(/client\.rank\(/);
    expect(DEV).not.toMatch(/client\.explain\(/);
  });
  // Non-vacuity: ground the example against the ACTUAL published SDK source.
  it('Free2AIClient is a real export and search() is a real method', () => {
    expect(SDK_INDEX).toMatch(/export\s*\{\s*Free2AIClient\s*\}/);
    expect(SDK_CLIENT).toMatch(/\bsearch\(req:\s*SearchRequest/);
  });
  it('rank()/explain() are documented MCP-only in the SDK (so absent by design)', () => {
    expect(SDK_CLIENT).toMatch(/rank\(\)[\s\S]{0,60}MCP-ONLY/);
  });
});

describe('SDK-SURFACE 6: SDK, REST and MCP all present as valid integration paths', () => {
  it('the neutral chooser offers all three surfaces', () => {
    expect(DEV).toMatch(/Use the TypeScript SDK/i);
    expect(DEV).toMatch(/Use the REST API/i);
    expect(DEV).toMatch(/Use the MCP server/i);
  });
  it('presents them as equally-valid (SDK does not replace REST/MCP)', () => {
    expect(DEV).toMatch(/remain fully supported alternatives/i);
    expect(DEV).toMatch(/according to your integration environment/i);
  });
});

describe('SDK-SURFACE 7: homepage SDK entry lives OUTSIDE frozen hero/meta', () => {
  it('the homepage integration nav carries the SDK entry', () => {
    expect(HOME).toMatch(/\/developers#sdk/);
    expect(HOME).toMatch(/TypeScript SDK/);
    expect(HOME).toContain(PKG); // in the pill title attribute
  });
  it('the frozen hero <h1> is unchanged and carries no SDK copy', () => {
    const h1 = (HOME.match(/<h1[\s\S]*?<\/h1>/) || [''])[0];
    expect(h1).toMatch(/The Open-Source[\s\S]*AI Registry/);
    expect(h1).not.toMatch(/SDK/i);
  });
  it('the frozen mission/value paragraph is unchanged and carries no SDK copy', () => {
    const mission = (HOME.match(/Discover and rank \{countText\}[\s\S]*?<\/p>/) || [''])[0];
    expect(mission).toMatch(/Scored by the Free2AITools Nexus Index \(FNI\)/);
    expect(mission).not.toMatch(/SDK/i);
  });
  it('the frozen homepage meta/OG description is unchanged and mentions no SDK', () => {
    const meta = 'Discover and rank open-source AI models, datasets, papers, and tools. Updated daily, scored by FNI. API and MCP Server available.';
    expect(INDEX).toContain(meta);
    expect(meta).not.toMatch(/SDK/i);
    // The homepage meta/hero source itself introduces no SDK package reference.
    expect(INDEX).not.toContain(PKG);
    expect(INDEX).not.toMatch(/TypeScript SDK/);
  });
});

describe('SDK-SURFACE 8: llms.txt carries the SDK package + docs pointer', () => {
  it('names the package + install + version', () => {
    expect(LLMS).toContain(PKG);
    expect(LLMS).toContain(INSTALL);
    expect(LLMS).toMatch(/\b0\.1\.0\b/);
  });
  it('describes it as a typed client for the existing API, not a new surface', () => {
    expect(LLMS).toMatch(/typed client for the existing public Free2AI REST API/i);
    expect(LLMS).toMatch(/NOT a\s*\n?\s*new API surface|not a new api surface/i);
  });
  it('points at /developers and keeps REST + MCP as supported alternatives', () => {
    expect(LLMS).toContain('/developers');
    expect(LLMS).toMatch(/remain fully supported/i);
    expect(LLMS).toMatch(/alternatives/i);
  });
});

describe('SDK-SURFACE 9: no forbidden over-claim on any edited public surface', () => {
  const surfaces: Array<[string, string]> = [
    ['developers.astro', DEV],
    ['HomeTechnicalHeader.astro', HOME],
    ['llms-template.txt', LLMS],
  ];
  for (const [name, src] of surfaces) {
    for (const [label, re] of FORBIDDEN) {
      it(`${name}: no "${label}"`, () => {
        expect(re.test(src), `forbidden claim "${label}" found in ${name}`).toBe(false);
      });
    }
  }
  // Anti-vacuity: the matcher is live (a synthetic over-claim IS caught).
  it('anti-vacuity: a synthetic over-claim string trips the matcher', () => {
    const probe = 'This SDK is production-ready and widely adopted, now at General Availability.';
    const hit = FORBIDDEN.some(([, re]) => re.test(probe));
    expect(hit).toBe(true);
  });
});

describe('SDK-SURFACE 10: documentation-only (REST endpoints + 5 MCP tools unchanged)', () => {
  it('the documented REST endpoints are intact', () => {
    for (const ep of ['/api/v1/search', '/api/v1/select', '/api/v1/compare', '/api/v1/entity']) {
      expect(DEV).toContain(ep);
    }
  });
  it('exactly the 5 MCP tools are documented (no new tool introduced)', () => {
    const tools = [
      'free2aitools_search', 'free2aitools_rank', 'free2aitools_explain',
      'free2aitools_select_model', 'free2aitools_compare',
    ];
    for (const t of tools) expect(DEV).toContain(t);
    const found = new Set(DEV.match(/free2aitools_[a-z_]+/g) || []);
    expect(found.size).toBe(5);
  });
  it('no SDK-specific API endpoint was invented', () => {
    expect(DEV).not.toMatch(/\/api\/v1\/sdk/i);
  });
});
