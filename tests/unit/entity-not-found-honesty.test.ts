import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// G-01 TRUE-404 HONESTY GATE (Founder, locked):
//   A genuine entity miss keeps HTTP 404 (correct) but its rendered body MUST NOT
//   fabricate future availability. A real miss only proves the entity is absent in
//   the CURRENT snapshot — it does NOT prove the entity is being indexed / will
//   appear / will recover. The absent-entity body must use factual, non-promise
//   language and offer real working links (Search / Explore / Catalog / Home).
//
// This test reads the EntityLayout.astro source (the shared `!hasEntity` fallback
// body) and asserts the honesty contract on the copy, plus that the detail routes
// keep 404 and 503 SEMANTICALLY DISTINCT (transient branch untouched).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function read(rel: string): string {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

// Extract only the absent-entity branch ( `!hasEntity ? ( ... ) : (` ) so we never
// accidentally match copy that belongs to the present-entity render.
function absentEntityBody(src: string): string {
    const start = src.indexOf('!hasEntity ? (');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(') : (', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
}

describe('G-01 — absent-entity body is factual, no fabricated future availability', () => {
    const layout = read('src/layouts/EntityLayout.astro');
    const body = absentEntityBody(layout);

    // -- No future-availability / indexing promises anywhere in the miss body ----
    const forbidden = [
        /being indexed/i,
        /indexing in progress/i,
        /entity being indexed/i,
        /will appear/i,
        /will be available/i,
        /available after the next/i,
        /after the next (daily update|index update)/i,
        /next daily update/i,
        /next index update/i,
        /still being processed/i,
        /being processed/i,
        /temporarily unavailable/i,
        /check back/i,
        /coming soon/i,
    ];
    for (const pat of forbidden) {
        it(`absent-entity body contains NO promise matching ${pat}`, () => {
            expect(body).not.toMatch(pat);
        });
    }

    it('absent-entity body has NO auto-retry / auto-refresh', () => {
        // No meta-refresh, no scripted reload, no "retry fetch" affordance.
        expect(body).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
        expect(body).not.toMatch(/location\.reload/i);
        expect(body).not.toMatch(/retry fetch/i);
    });

    it('absent-entity body states the factual "not found in current snapshot" framing', () => {
        expect(body).toMatch(/not found in the current data snapshot/i);
        expect(body).toMatch(/Entity Not Found/i);
    });

    it('absent-entity body offers REAL working links (existing routes only)', () => {
        // Search, Explore, Catalog Index (/ranking), Home — all must point at routes
        // that actually exist in src/pages.
        expect(body).toMatch(/href=\{`\/search\?q=/);
        expect(body).toMatch(/href="\/explore"/);
        expect(body).toMatch(/href="\/ranking"/);
        expect(body).toMatch(/href="\/"/);

        for (const route of ['search.astro', 'explore.astro', 'ranking', 'index.astro']) {
            expect(fs.existsSync(path.join(repoRoot, 'src', 'pages', route))).toBe(true);
        }
    });
});

describe('G-01 — detail routes keep 404 and 503 semantically distinct', () => {
    // The status-code split lives in the detail route, NOT in EntityLayout. A
    // genuine miss = 404; a transient/cold lookup = 503 + Retry-After. They must
    // remain two distinct branches; this fix must not collapse them.
    for (const route of [
        'src/pages/model/[...slug].astro',
        'src/pages/paper/[...slug].astro',
        'src/pages/dataset/[...slug].astro',
        'src/pages/tool/[...slug].astro',
        'src/pages/benchmark/[...slug].astro',
    ]) {
        it(`${route} still sets BOTH 404 and 503 (distinct branches)`, () => {
            const src = read(route);
            expect(src).toMatch(/status\s*=\s*404/);
            expect(src).toMatch(/status\s*=\s*503/);
            // The 503 branch keeps its transient contract (Retry-After + no-store).
            expect(src).toMatch(/Retry-After/);
            expect(src).toMatch(/no-store/);
        });
    }
});
