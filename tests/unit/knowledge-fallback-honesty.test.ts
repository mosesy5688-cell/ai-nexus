import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// P-04 KNOWLEDGE PLACEHOLDER HONESTY GATE (Founder, locked; same family as G-01):
//   When a config article resolves but has NO real content (articles[canonicalSlug]
//   is empty), the knowledge route synthesizes a fallback body. That fallback MUST
//   NOT fabricate a future / active-processing claim ("being aggregated in the
//   Knowledge Mesh", "being indexed", "will appear", ...). An empty entry only
//   proves there is no content in the CURRENT snapshot — it does NOT prove the
//   topic is being aggregated/ingested/indexed or that content will arrive.
//
//   The factual fallback must use present-tense, non-promise language ("No article
//   content is available for this entry in the current snapshot.") and offer only
//   real working navigation (e.g. /knowledge). It must NOT change the status-code
//   logic (200 for resolved article / 404 for unknown slug).
//
// This test reads src/pages/knowledge/[slug].astro and asserts the honesty
// contract on the static-fallback content string, plus that the 404 short-circuit
// is preserved.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function read(rel: string): string {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

describe('P-04 — knowledge static-fallback body is factual, no fabricated processing/aggregation claim', () => {
    const src = read('src/pages/knowledge/[slug].astro');

    // -- No future-availability / active-processing / aggregation promises -------
    const forbidden = [
        /being aggregated/i,
        /currently being aggregated/i,
        /Knowledge Mesh\./i,           // the specific "...in the Knowledge Mesh." fabrication
        /being indexed/i,
        /indexing in progress/i,
        /being processed/i,
        /still being processed/i,
        /will appear/i,
        /will be available/i,
        /coming soon/i,
        /check back/i,
        /next (daily|index) update/i,
    ];
    for (const pat of forbidden) {
        it(`fallback source contains NO promise matching ${pat}`, () => {
            expect(src).not.toMatch(pat);
        });
    }

    it('fallback states the factual "not available in current snapshot" framing', () => {
        expect(src).toMatch(/No article content is available for this entry in the current snapshot\./);
    });

    it('fallback offers a REAL working link to the knowledge base', () => {
        expect(src).toMatch(/\]\(\/knowledge\)/);
        // The /knowledge index route exists as src/pages/knowledge.astro.
        expect(fs.existsSync(path.join(repoRoot, 'src', 'pages', 'knowledge.astro'))).toBe(true);
    });

    it('status-code logic is preserved (404 short-circuit on unresolved article)', () => {
        // The unknown-slug branch must still set 404; this fix must not collapse it.
        expect(src).toMatch(/Astro\.response\.status\s*=\s*404/);
    });
});
