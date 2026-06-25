/**
 * SRS-1 -- public-honesty invariant (tier-1, hermetic).
 *
 * P3-CONTRACT-1 PR-B (Public Honesty & Discovery). These locks pin the
 * human-facing public surfaces (methodology.astro / README.md /
 * sitemap-static.xml.ts / developers.astro) to the currently-implemented
 * truth -- a CONTRACT-PROJECTION / DOCUMENTATION guard, NOT a behavior test.
 *
 * Invariants:
 *  T6  (C5/DJ-W01) methodology source_trail honesty: does NOT claim a
 *      complete/delivered source_trail; states it is NOT currently exposed
 *      publicly + that the fuller capability is PLANNED; no fabricated-
 *      provenance promise; no raw-snapshot/timestamp/content-hash current claim.
 *  T7  (C8/DJ-D02) README served entity types: current-product wording carries
 *      NO cancelled type (agent/space/prompt) and NO ungrounded platform count
 *      ("13+"/"NN+ platforms").
 *  T8  (C9/DJ-D03) sitemap discovery: /developers IS present in STATIC_PAGES,
 *      same-host, and retired routes stay excluded.
 *  T-IDENTITY (C7/DJ-W05) developers.astro distinguishes id / canonical_id /
 *      umid; NO "id IS umid" / "id field ... is your UMID" equivalence.
 *  T-PMC-BOUNDARY corrected wording preserves the identity sentence +
 *      caller-decides / no-verdict / no-router / no-adoption negative contract.
 *
 * HERMETIC: reads SOURCE/CONFIG only. No live fetch. Deterministic across runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);
const read = (rel: string) => readFileSync(abs(rel), 'utf8');

// --- T6: methodology source_trail honesty -------------------------------
describe('SRS-1 T6: methodology source_trail wording is honest', () => {
    const src = read('src/pages/methodology.astro');
    // Isolate the Forensic Data Traceability (Pillar 1) block.
    const pillar = (src.match(/Forensic Data Traceability[\s\S]*?<\/p>/) || [''])[0];

    it('Pillar-1 block is present', () => {
        expect(pillar.length).toBeGreaterThan(0);
    });

    it('does NOT claim a complete/delivered source_trail', () => {
        // The retired "complete audit trail" + "every input is traceable" claim
        // must be gone.
        expect(pillar).not.toMatch(/complete audit trail/i);
        expect(pillar).not.toMatch(/every input is traceable/i);
    });

    it('states source_trail is NOT currently publicly exposed', () => {
        expect(pillar).toMatch(/source_trail/);
        expect(pillar).toMatch(/do not currently expose/i);
    });

    it('preserves the future evidence-chain ambition (planned)', () => {
        expect(pillar).toMatch(/planned/i);
        expect(pillar).toMatch(/evidence-chain/i);
    });

    it('does not promise raw snapshots / timestamps / content hashes as current public fields', () => {
        expect(pillar).not.toMatch(/raw data snapshots/i);
        expect(pillar).not.toMatch(/collection timestamps/i);
        expect(pillar).not.toMatch(/content hashes/i);
    });

    it('carries the no-fabrication provenance contract', () => {
        expect(pillar).toMatch(/does not fabricate missing provenance/i);
    });
});

// --- T7: README served types + no ungrounded count ----------------------
describe('SRS-1 T7: README current-product wording is honest', () => {
    const readme = read('README.md');
    const lines = readme.split('\n');
    const headline = lines[4] || '';           // README.md:5
    const catalogBullet = (readme.match(/\*\*Cross-source catalog\*\*[^\n]*/) || [''])[0];

    it('headline (:5) lists only served entity types', () => {
        expect(headline).toMatch(/models, datasets, papers, tools, and benchmarks/i);
    });

    it('headline (:5) drops the ungrounded "13+ platforms" count with no numeric replacement', () => {
        expect(headline).not.toMatch(/13\+/);
        expect(headline).not.toMatch(/\d+\+\s*(platforms|sources)/i);
    });

    it('headline (:5) keeps the daily-cadence + FNI clause', () => {
        expect(headline).toMatch(/Updated daily, scored by the Free2AITools Nexus Index \(FNI\)\./);
    });

    it('current-product wording carries NO cancelled type (agent/space/prompt)', () => {
        // Restrict to the marketing surfaces (headline + catalog bullet) -- those
        // are the "current product" claims under amendment C8.
        for (const surface of [headline, catalogBullet]) {
            expect(surface).not.toMatch(/\bagents?\b/i);
            expect(surface).not.toMatch(/\bspaces?\b/i);
            expect(surface).not.toMatch(/\bprompts?\b/i);
        }
    });

    it('catalog bullet keeps factual platform names + "and more"', () => {
        expect(catalogBullet).toMatch(/HuggingFace/);
        expect(catalogBullet).toMatch(/and more/);
    });

    it('whole README introduces no replacement numeric platform/source count', () => {
        expect(readme).not.toMatch(/\d+\+\s*(platforms|sources)/i);
    });
});

// --- T8: sitemap discovery ----------------------------------------------
describe('SRS-1 T8: sitemap advertises /developers, excludes retired', () => {
    const sitemap = read('src/pages/sitemap-static.xml.ts');
    const declared = [...sitemap.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);

    it('/developers IS present in STATIC_PAGES', () => {
        expect(declared).toContain('/developers');
    });

    it('no duplicate path entries', () => {
        expect(new Set(declared).size).toBe(declared.length);
    });

    it('retired routes stay excluded', () => {
        for (const retired of ['/reports', '/agents', '/spaces', '/prompts', '/agent', '/space', '/prompt']) {
            expect(declared).not.toContain(retired);
        }
    });

    it('all URLs are same-host (built from BASE_URL only)', () => {
        // No absolute http(s) URL is hardcoded into a path entry.
        for (const p of declared) {
            expect(p.startsWith('/')).toBe(true);
            expect(p).not.toMatch(/^https?:\/\//);
        }
        expect(sitemap).toMatch(/BASE_URL\}\$\{page\.path\}/);
    });
});

// --- T-IDENTITY: id / canonical_id / umid distinction -------------------
describe('SRS-1 T-IDENTITY: developers.astro identifier wording', () => {
    const dev = read('src/pages/developers.astro');

    it('does NOT claim id IS the UMID', () => {
        expect(dev).not.toMatch(/id<\/code>\s*field in the response is your UMID/i);
        expect(dev).not.toMatch(/\bid\b[^.]{0,40}\bis your UMID\b/i);
    });

    it('distinguishes id, canonical_id, and umid', () => {
        expect(dev).toMatch(/canonical_id/);
        expect(dev).toMatch(/canonical entity identifier/i);
        expect(dev).toMatch(/UMID is a separate derived/i);
        expect(dev).toMatch(/callers do not need to compute it/i);
    });
});

// --- G-5 (D-121): free-service honesty on machine surfaces --------------
// The agent-ingested surfaces (llms.txt template + OpenAPI schema) must state
// only present facts: no advertisement of an UNBUILT paid/auth tier
// (Commercialization Constitution C2: unbuilt capabilities never on API-Docs /
// machine surfaces), no "unlimited", no numeric monthly quota, no SLA uptime-%
// claim. The honest "limits may change in future" caveat IS permitted.
describe('SRS-1 G-5: machine surfaces carry no unbuilt-tier / unlimited / quota / SLA copy', () => {
    const surfaces: ReadonlyArray<readonly [string, string]> = [
        ['llms-template.txt', read('src/data/llms-template.txt')],
        ['openapi-schema.json', read('src/data/openapi-schema.json')],
    ];

    for (const [name, src] of surfaces) {
        it(`${name}: no unbuilt paid/auth-tier advertisement ("paid tiers (TBD) raise the cap" / "raised limits TBD")`, () => {
            expect(src).not.toMatch(/paid\s+tiers?\s*\(tbd\)/i);
            expect(src).not.toMatch(/raise the cap/i);
            expect(src).not.toMatch(/raised limits\s+TBD/i);
        });
        it(`${name}: no "unlimited" claim`, () => {
            expect(src).not.toMatch(/\bunlimited\b/i);
        });
        it(`${name}: no numeric monthly request quota`, () => {
            expect(src).not.toMatch(/\d[\d,]*\s*requests?\s*(?:per|\/)\s*month/i);
        });
        it(`${name}: no SLA uptime-percentage claim`, () => {
            // Guard the "99.9% uptime"-style SLA claim. Technical observability
            // fields ("isolate uptime", "isolate_uptime_ms") carry no % and are
            // therefore not matched.
            expect(src).not.toMatch(/\d+(?:\.\d+)?\s*%\s*uptime/i);
            expect(src).not.toMatch(/uptime\s*[:=]?\s*\d+(?:\.\d+)?\s*%/i);
        });
    }

    it('llms-template states the honest present fact + may-change caveat (no paid-tier naming)', () => {
        const llms = read('src/data/llms-template.txt');
        expect(llms).toMatch(/Free tier hard-cap: 20 results/);
        expect(llms).toMatch(/limits may change in future/i);
    });
});

// --- T-PMC-BOUNDARY: preserved identity + negative contract -------------
describe('SRS-1 T-PMC-BOUNDARY: identity + negative contract preserved', () => {
    const dev = read('src/pages/developers.astro');
    const footer = read('src/components/Footer.astro');

    it('identity sentence preserved (Footer -- public surface, untouched by PR-B)', () => {
        expect(footer).toMatch(/Structured discovery, evidence, and identity layer for AI agents/i);
    });

    it('caller-decides negative contract preserved on developers.astro', () => {
        // The select endpoint keeps "the caller is responsible for final model selection".
        expect(dev).toMatch(/caller is responsible for final model selection/i);
    });

    it('no-router / no-adoption / no-verdict language not introduced by corrected wording', () => {
        // Corrected C5/C7/C3 wording must not add autonomous-verdict/router claims.
        // Guard the specific blocks we touched.
        const umidBlock = (dev.match(/Finding your identifier:[\s\S]*?<\/div>/) || [''])[0];
        const pagBlock = (dev.match(/Pagination:[\s\S]*?<\/p>/) || [''])[0];
        for (const block of [umidBlock, pagBlock]) {
            expect(block).not.toMatch(/\brecommend(s|ed|ation)?\b/i);
            expect(block).not.toMatch(/\brouter?\b/i);
            expect(block).not.toMatch(/\bverdict\b/i);
        }
    });
});
