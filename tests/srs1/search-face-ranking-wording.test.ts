/**
 * SRS-1 -- search-face ranking-wording invariants (tier-1, hermetic).
 *
 * Pins the CORRECTED search-face ordering wording so the retracted over-claims
 * cannot creep back. Two claims were wrong in opposite directions and both are
 * guarded here:
 *
 *   (a) "FNI-ranked" / "ranked by FNI score" / "rank ... by FNI score"
 *       -- overstates: the FNI is not the ordering key.
 *   (b) "the FNI is the largest single component"
 *       -- ALSO overstates: in `term-index-engine.ts:161` the blend is
 *          `fniScore * 0.6 + bm25 * 40 * 0.4`, so the effective coefficients are
 *          FNI 0.6 vs BM25 16 (the *40 sits INSIDE the 0.4 term). The FNI term is
 *          the larger contributor only for query terms occurring in >~15% of the
 *          catalog, which real queries essentially never hit.
 *
 * The wording therefore makes ZERO magnitude assertion, and must be true on BOTH
 * exits of the `term-index-engine.ts:160-162` ternary:
 *   :161  totalDocs > 0  -> blended FNI + term-match score
 *   :162  totalDocs == 0 -> pure FNI ("graceful degradation", :154) -- so the
 *                           match clause is conditional ("where ... available").
 * On BOTH exits the response is still not ordered by the RETURNED `fni_score`:
 * the postings carry `Math.round(fni_score)` (inverted-index-builder.js:99) while
 * the response carries the unrounded `e.fni_score` (search.ts DISPLAY_COLS), so
 * rounding ties permit inversions in the returned float.
 *
 * Third direction guarded: the wording must NOT flip to "FNI is not involved" --
 * it IS involved, on both exits.
 *
 * Scope note: this pins the SEARCH face only. Bucket B (filter/select) and the
 * site-wide/identity wording legitimately still say "FNI-ranked" and are NOT
 * asserted here; the browse/ranking listings really are FNI-ordered.
 *
 * Reads repo SOURCE + builds the catalog manifest + invokes the openapi.json.ts
 * route GET (cloudflare:workers mocked in vitest.config). No live fetch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
// Only the SEARCH entry of the manifest is a corrected surface. The select entry
// (bucket B) and the identity prose legitimately still say "FNI-ranked".
const CATALOG_SEARCH_ENTRY = JSON.stringify(
    (CATALOG_MANIFEST as any).entries.find((e: any) => String(e.url).endsWith('/api/v1/search')),
);

// Line-wrapped sources (llms-template, concatenated TS strings) must compare on
// normalized whitespace, else a re-wrap silently breaks the pin.
const norm = (s: string) => s.replace(/\s+/g, ' ');

// The corrected clause, in the two spellings actually shipped.
const CLAUSE = 'a relevance score based on the FNI and, where term-match data is available, how well the entry matches the query';
const CLAUSE_FULLNAME = 'a relevance score based on the FNI (Free2AITools Nexus Index) and, where term-match data is available, how well the entry matches the query';

const tool = (name: string) => mcpJson.tools.find((t: any) => t.name === name).description;

let served = '';
beforeAll(async () => {
    const res = await (OPENAPI_GET as any)({ request: new Request('https://x/openapi.json') });
    served = JSON.parse(await res.text())?.paths?.['/api/v1/search']?.get?.description ?? '';
});

describe('search-face wording: the corrected clause is present on every search surface', () => {
    it('SERVED /api/v1/search description carries the clause + the fni_score caveat + bounded', () => {
        expect(norm(served)).toContain(CLAUSE);
        expect(norm(served)).toContain('The response is not ordered by the `fni_score` field it returns, and the result set is bounded.');
    });
    it('static OpenAPI search path + 200 response carry it', () => {
        expect(norm(schema.paths['/api/v1/search'].get.description)).toContain(CLAUSE);
        expect(norm(schema.paths['/api/v1/search'].get.responses['200'].description)).toContain(CLAUSE);
    });
    it('MCP manifest search + rank tools carry it', () => {
        expect(norm(tool('free2aitools_search'))).toContain(CLAUSE);
        expect(norm(tool('free2aitools_rank'))).toContain(CLAUSE);
    });
    it('MCP handler search + rank tool descriptions carry it', () => {
        expect(norm(MCP_SRC)).toContain(CLAUSE_FULLNAME);   // search tool
        expect(norm(MCP_SRC)).toContain(CLAUSE);            // rank tool
    });
    it('machine-readable catalog manifest search entry carries it', () => {
        expect(norm(CATALOG)).toContain(CLAUSE_FULLNAME);
    });
    it('llms.txt search entry carries it (line-wrapped -> normalized)', () => {
        expect(norm(LLMS)).toContain('Results are ordered by ' + CLAUSE);
    });
    it('developers page carries it on the boundary note and the search/rank tool cards', () => {
        // 3 sites: the "Discovery layer only" note, free2aitools_search card, free2aitools_rank card.
        const hits = norm(DEVELOPERS).split(CLAUSE).length - 1;
        expect(hits).toBeGreaterThanOrEqual(3);
    });
    it('the per-row semantic note discloses the ordering caveat too', () => {
        expect(FNI_S_NOTE).toContain('results are not ordered by the returned fni_score');
        // ... and does NOT flip into claiming the FNI is uninvolved.
        expect(FNI_S_NOTE).toContain('contributes to the ordering score');
    });
});

describe('search-face wording: neither over-claim can come back', () => {
    const CORRECTED = [
        ['served openapi description', () => served],
        ['static openapi schema', () => JSON.stringify(schema.paths['/api/v1/search'])],
        ['mcp manifest search tool', () => tool('free2aitools_search')],
        ['mcp manifest rank tool', () => tool('free2aitools_rank')],
        ['catalog manifest search entry', () => CATALOG_SEARCH_ENTRY],
    ] as const;

    it('direction 1: no "ranked by FNI" / "FNI-ranked" / "rank ... by FNI" on a corrected surface', () => {
        // Family derived from the PROPERTY (any assertion binding search/rank order
        // to the FNI), not from a list of known sites -- a list cannot expose its
        // own omissions.
        const FAMILY = /FNI-ranked|ranked by FNI|rank .* by FNI/;
        for (const [label, get] of CORRECTED) {
            expect(FAMILY.test(get()), `${label} must not re-assert FNI ordering`).toBe(false);
        }
    });

    it('direction 2: no magnitude assertion about the FNI anywhere in the repo surfaces', () => {
        const MAGNITUDE = /largest single component|largest single term|dominant factor|primary ranking factor/;
        for (const src of [served, JSON.stringify(schema), JSON.stringify(mcpJson), MCP_SRC, DEVELOPERS, LLMS, CATALOG, FNI_S_NOTE]) {
            expect(MAGNITUDE.test(src)).toBe(false);
        }
    });

    it('direction 3: never flips to claiming the FNI is uninvolved', () => {
        const FLIPPED = /unrelated to FNI|not related to FNI|FNI is not used|does not use FNI|independent of FNI|FNI plays no/i;
        for (const src of [served, JSON.stringify(schema), JSON.stringify(mcpJson), MCP_SRC, DEVELOPERS, LLMS, CATALOG, FNI_S_NOTE]) {
            expect(FLIPPED.test(src)).toBe(false);
        }
        // positive side: the FNI is still named as a participant on the search face.
        expect(norm(served)).toContain('based on the FNI');
    });

    it('the conditional match clause survives (must stay true on the pure-FNI fallback exit)', () => {
        // Dropping "where term-match data is available" would make the sentence
        // false on term-index-engine.ts:162 (totalDocs == 0 -> blended = fniScore).
        expect(norm(served)).toContain('where term-match data is available');
        expect(norm(tool('free2aitools_search'))).toContain('where term-match data is available');
        expect(norm(CATALOG)).toContain('where term-match data is available');
    });
});

describe('search-face wording: behaviour untouched', () => {
    it('fni_score is still a returned field, not nulled', () => {
        expect(schema.components.schemas.SearchResponse.properties.results.items.properties.fni_score).toBeDefined();
        expect(read('src/constants/evidence-contract.js')).toContain('row.fni_s = null;');
        expect(read('src/constants/evidence-contract.js')).not.toContain('fni_score = null');
    });
});
