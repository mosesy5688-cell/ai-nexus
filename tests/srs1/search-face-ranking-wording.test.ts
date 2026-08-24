/**
 * SRS-1 -- search-face ranking-wording invariants (tier-1, hermetic).
 *
 * Pins the finalised search-face ordering sentence and guards the three ways it
 * has already gone wrong, plus a repo-wide whitelist scan so a NEW unenumerated
 * site cannot appear silently.
 *
 * Why the sentence is shaped the way it is -- all four constraints are load-bearing:
 *
 *   1. NOT "FNI-ranked" / "ranked by FNI score" / "rank ... by FNI score".
 *      The FNI is not the ordering key.
 *
 *   2. NOT "the FNI is the largest single component" either. In
 *      `term-index-engine.ts:161` the blend is `fniScore * 0.6 + bm25 * 40 * 0.4`,
 *      so the `* 40` sits INSIDE the 0.4 term and the effective coefficients are
 *      FNI 0.6 vs BM25 16. The FNI term is the larger contributor only for query
 *      words occurring in more than ~15% of the catalog. Hence: ZERO magnitude claim.
 *
 *   3. The match clause stays CONDITIONAL ("where term-match data is available").
 *      `:160-162` is a ternary: `:161` blends FNI + term-match, `:162` degrades to
 *      pure FNI when the manifest is missing (`:154` "graceful degradation: pure FNI
 *      if no manifest"). An unconditional "matching participates" would be false on `:162`.
 *
 *   4. NO timing word at all. `:154` says the BM25 is computed at QUERY time, while
 *      the `:162` key is the index-time `Math.round(fni_score)` from
 *      `inverted-index-builder.js:99`. The two exits differ in timing, so any single
 *      timing word is false on one of them. The claim callers need is
 *      "ordering key != returned field", not when it was computed.
 *
 * "may differ" is realised, not hypothetical: the ordering key on `:162` is the
 * ROUNDED integer while the response returns the unrounded `e.fni_score`
 * (`search.ts:30` DISPLAY_COLS), so rounding ties permit inversions in the
 * returned float.
 *
 * Scope: the SEARCH face only. Bucket B (filter/select), the browse/ranking
 * listings (which really are FNI-ordered) and the site-wide identity wording
 * legitimately still say "FNI-ranked" -- those are whitelisted below, per line.
 *
 * Reads repo SOURCE + builds the catalog manifest + invokes the openapi.json.ts
 * route GET (cloudflare:workers mocked in vitest.config). No live fetch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { GET as OPENAPI_GET } from '../../src/pages/openapi.json.ts';
import { buildAiCatalog } from '../../src/pages/.well-known/ai-catalog.json.ts';
import { FNI_S_NOTE } from '../../src/constants/evidence-contract.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);

const schema = require('../../src/data/openapi-schema.json');
const mcpJson = require('../../public/.well-known/mcp.json');
const MCP_SRC = read('src/pages/api/mcp.ts');
const DEVELOPERS = read('src/pages/developers.astro');
const LLMS = read('src/data/llms-template.txt');
const CATALOG_MANIFEST = buildAiCatalog('https://free2aitools.com');
const CATALOG = JSON.stringify(CATALOG_MANIFEST, null, 2);
// Only the SEARCH entry of the manifest is a corrected surface.
const CATALOG_SEARCH_ENTRY = JSON.stringify(
    (CATALOG_MANIFEST as any).entries.find((e: any) => String(e.url).endsWith('/api/v1/search')),
);

// Line-wrapped sources (llms-template, concatenated TS strings) compare on
// normalized whitespace, else a re-wrap silently breaks the pin.
const norm = (s: string) => s.replace(/\s+/g, ' ');

// ---- the finalised sentence, verbatim ----
const LOCKED = 'Search results are ordered by a relevance score based on the FNI and, where term-match data is available, how well the entry matches the query. The score used for ordering may differ from the fni_score field returned in the response.';
// Same sentence with the index name glossed (surfaces whose parity tests need the literal).
const LOCKED_FN = LOCKED.replace('based on the FNI and,', 'based on the FNI (Free2AITools Nexus Index) and,');
const BOUNDED = 'The result set is bounded.';

const tool = (name: string) => mcpJson.tools.find((t: any) => t.name === name).description;

let served = '';
beforeAll(async () => {
    const res = await (OPENAPI_GET as any)({ request: new Request('https://x/openapi.json') });
    served = JSON.parse(await res.text())?.paths?.['/api/v1/search']?.get?.description ?? '';
});

describe('search-face wording: the finalised sentence is present on every search surface', () => {
    it('SERVED /api/v1/search description', () => {
        expect(norm(served)).toContain(LOCKED);
        expect(norm(served)).toContain(BOUNDED);
    });
    it('static OpenAPI search path + 200 response', () => {
        expect(norm(schema.paths['/api/v1/search'].get.description)).toContain(LOCKED);
        expect(norm(schema.paths['/api/v1/search'].get.responses['200'].description)).toContain(LOCKED);
    });
    it('MCP manifest search + rank tools', () => {
        expect(norm(tool('free2aitools_search'))).toContain(LOCKED);
        expect(norm(tool('free2aitools_rank'))).toContain(LOCKED);
    });
    it('MCP handler search + rank tool descriptions', () => {
        expect(norm(MCP_SRC)).toContain(LOCKED_FN);   // search tool
        expect(norm(MCP_SRC)).toContain(LOCKED);      // rank tool
    });
    it('machine-readable catalog manifest search entry', () => {
        expect(norm(CATALOG_SEARCH_ENTRY)).toContain(LOCKED_FN);
    });
    it('llms.txt search entry (line-wrapped -> normalized)', () => {
        expect(norm(LLMS)).toContain(LOCKED);
    });
    it('developers page: all FOUR instances share the one sentence', () => {
        // boundary note, GET /api/v1/search main description, free2aitools_search
        // card, free2aitools_rank card -- one sentence, not four variants.
        const hits = norm(DEVELOPERS).split(LOCKED).length - 1;
        expect(hits).toBe(4);
    });
    it('the per-row semantic note uses the same formulation', () => {
        expect(FNI_S_NOTE).toContain('based on the FNI but may differ from the returned fni_score');
    });
});

describe('search-face wording: none of the three failure directions can come back', () => {
    const CORRECTED: ReadonlyArray<readonly [string, () => string]> = [
        ['served openapi description', () => served],
        ['static openapi search path', () => JSON.stringify(schema.paths['/api/v1/search'])],
        ['mcp manifest search tool', () => tool('free2aitools_search')],
        ['mcp manifest rank tool', () => tool('free2aitools_rank')],
        ['catalog manifest search entry', () => CATALOG_SEARCH_ENTRY],
    ];
    const ALL = () => [served, JSON.stringify(schema), JSON.stringify(mcpJson), MCP_SRC, DEVELOPERS, LLMS, CATALOG, FNI_S_NOTE];

    it('direction 1: no "FNI-ranked" / "ranked by FNI" / "rank ... by FNI" on a corrected surface', () => {
        const FAMILY = /FNI-ranked|ranked by FNI|rank .* by FNI/;
        for (const [label, get] of CORRECTED) {
            expect(FAMILY.test(get()), `${label} must not re-assert FNI ordering`).toBe(false);
        }
    });
    it('direction 2: no magnitude assertion about the FNI', () => {
        const MAGNITUDE = /largest single component|largest single term|dominant factor|primary ranking factor/;
        for (const src of ALL()) expect(MAGNITUDE.test(src)).toBe(false);
    });
    it('direction 3: never flips to claiming the FNI is uninvolved', () => {
        const FLIPPED = /unrelated to FNI|not related to FNI|FNI is not used|does not use FNI|independent of FNI|FNI plays no/i;
        for (const src of ALL()) expect(FLIPPED.test(src)).toBe(false);
        expect(norm(served)).toContain('based on the FNI');
    });
    it('direction 4: no timing word attached to the ordering score', () => {
        // The two exits differ in timing, so any single timing word is false on one.
        const TIMING = /score used for ordering is computed at|computed at index time|computed at query time/;
        for (const src of ALL()) expect(TIMING.test(src)).toBe(false);
    });
    it('the conditional match hedge survives (else false on the pure-FNI exit)', () => {
        expect(norm(served)).toContain('where term-match data is available');
        expect(norm(tool('free2aitools_search'))).toContain('where term-match data is available');
        expect(norm(CATALOG_SEARCH_ENTRY)).toContain('where term-match data is available');
    });
});

/**
 * Acceptance K -- repo-wide family whitelist scan.
 *
 * The assertion family may appear ONLY at the locations recorded here (bucket B
 * filter/select, bucket C site-wide identity, bucket D browse/ranking listings,
 * and the G3-pending list). A family match in any file not listed, or more
 * matching lines in a listed file than recorded, fails this test -- so a new site
 * must be explicitly whitelisted or rewritten. It cannot appear silently.
 *
 * Residual, named: a swap WITHIN one file that keeps its count unchanged would
 * not trip the count. The positive pins above cover the corrected sites, so such
 * a swap could only occur among already-whitelisted non-search lines.
 */
describe('search-face wording: acceptance K -- repo-wide family whitelist', () => {
    const FAMILY = /FNI-ranked|ranked by FNI|rank .* by FNI/;
    // file -> expected number of MATCHING LINES, with the bucket that justifies it.
    const WHITELIST: Record<string, number> = {
        // bucket C -- site-wide / identity wording, deferred
        'src/layouts/Layout.astro': 2,
        'src/components/common/OnboardingTour.astro': 1,
        'src/pages/open-data.astro': 1,
        'src/pages/index.astro': 4,           // :26 SEO description + 3 section labels
        'src/data/llms-template.txt': 2,      // identity header + deterministic-ranking note
        // bucket B (filter/select) + bucket C, same files
        'public/.well-known/mcp.json': 2,     // identity description + select_model tool
        'src/data/openapi-schema.json': 4,    // identity + select summary/description/200
        'src/pages/api/mcp.ts': 2,            // SERVER_BOUNDARY + select_model tool
        'src/pages/.well-known/ai-catalog.json.ts': 3, // identity x2 + select entry
        'src/pages/developers.astro': 5,      // select cards x2 + agent prose x2 + footer
        // bucket D -- browse / ranking listings, which really ARE FNI-ordered
        'src/pages/benchmarks.astro': 1,
        'src/pages/datasets.astro': 1,
        'src/pages/papers.astro': 1,
        'src/pages/tools.astro': 1,
        // G3 pending
        'README.md': 1,
    };

    function scan(): Record<string, number> {
        const out: Record<string, number> = {};
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
                const full = join(dir, name);
                if (statSync(full).isDirectory()) { walk(full); continue; }
                let text: string;
                try { text = readFileSync(full, 'utf8'); } catch { continue; }
                const n = text.split(/\r?\n/).filter((l) => FAMILY.test(l)).length;
                if (n > 0) out[relative(root, full).split(sep).join('/')] = n;
            }
        };
        walk(resolve(root, 'src'));
        walk(resolve(root, 'public'));
        const rm = readFileSync(resolve(root, 'README.md'), 'utf8');
        const n = rm.split(/\r?\n/).filter((l) => FAMILY.test(l)).length;
        if (n > 0) out['README.md'] = n;
        return out;
    }

    it('the family appears at NO location outside the whitelist', () => {
        const found = scan();
        const unlisted = Object.keys(found).filter((f) => !(f in WHITELIST));
        expect(unlisted, `unwhitelisted search/rank-vs-FNI assertion in: ${unlisted.join(', ')}`).toEqual([]);
    });

    it('no whitelisted file gained matching lines', () => {
        const found = scan();
        const grown = Object.keys(found)
            .filter((f) => f in WHITELIST && found[f] > WHITELIST[f])
            .map((f) => `${f} (${WHITELIST[f]} -> ${found[f]})`);
        expect(grown, `new family assertion added to: ${grown.join(', ')}`).toEqual([]);
    });

    it('no whitelist entry is stale (removals must be de-listed, keeping the list honest)', () => {
        const found = scan();
        const stale = Object.keys(WHITELIST)
            .filter((f) => (found[f] ?? 0) < WHITELIST[f])
            .map((f) => `${f} (${WHITELIST[f]} -> ${found[f] ?? 0})`);
        expect(stale, `whitelist over-counts: ${stale.join(', ')}`).toEqual([]);
    });
});

describe('search-face wording: behaviour untouched', () => {
    it('fni_score is still a returned field, not nulled', () => {
        expect(schema.components.schemas.SearchResponse.properties.results.items.properties.fni_score).toBeDefined();
        expect(read('src/constants/evidence-contract.js')).toContain('row.fni_s = null;');
        expect(read('src/constants/evidence-contract.js')).not.toContain('fni_score = null');
    });
});
