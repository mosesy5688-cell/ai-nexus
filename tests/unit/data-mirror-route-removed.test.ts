/**
 * data-mirror proxy route removal invariant (B1, SECURITY — Founder D-180).
 *
 * src/pages/data-mirror/[...path].ts was an Astro SSR catch-all ROUTE that, in
 * the production output:'server' + Cloudflare deployment, was publicly reachable
 * at /data-mirror/<path>. On GET it fetched
 * `https://cdn.free2aitools.com/cache/${path}` and returned the JSON body with
 * `Access-Control-Allow-Origin: *` — a GET-only proxy with NO size limit, NO
 * timeout, and NO header forwarding. Classification:
 * PREFIX_CONFINED_PROXY_WITH_UNJUSTIFIED_PROD_EXPOSURE (the target host/prefix is
 * a fixed literal, so it is NOT an SSRF — but a "CORS bypass proxy for local
 * development" has no production justification and was exposed in prod with zero
 * tracked callers). The approved remediation DELETES the route file. With no
 * route file under src/pages/, Astro cannot route the path, so a public request
 * to /data-mirror/* returns HTTP 404 (structural) — the required behavior.
 *
 * This guard locks the removal permanently and fail-closed:
 *  - the production route file is ABSENT (=> public 404);
 *  - NO replacement data-mirror route exists anywhere under src/pages/;
 *  - NO redirect/middleware authority recreates /data-mirror/* (read-only scan);
 *  - NO tracked RUNTIME source (src/**, scripts/**) references the retired path;
 *  - the route scan is NON-VACUOUS (it discovers real route files);
 *  - a missing routing root FAILS (fail-closed, never a silent pass);
 *  - a synthetic reintroduction turns the detectors RED (anti-vacuity).
 *
 * Allowlist: the runtime-reference scan is scoped to src/** and scripts/**
 * runtime code only, so historical governance docs, brain memos, and this test's
 * own forbidden-string fixture (which live OUTSIDE those trees) never false-trip.
 */
import { describe, it, expect } from 'vitest';
import {
    existsSync, readdirSync, readFileSync, statSync,
    mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, sep } from 'path';
import { tmpdir } from 'os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);
const norm = (p: string) => p.split(sep).join('/');

const FORBIDDEN = 'data-mirror';
const ROUTE_EXT = /\.(ts|js|mjs|astro)$/;
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|astro)$/;
const RETIRED_ROUTE = 'src/pages/data-mirror/[...path].ts';

// Recursively list every file under `dir`. THROWS if `dir` is absent so a
// missing routing root can never silently pass as "nothing forbidden found".
function listFiles(dir: string): string[] {
    if (!existsSync(dir)) {
        throw new Error(`expected routing root missing (fail-closed): ${dir}`);
    }
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...listFiles(full));
        else out.push(full);
    }
    return out;
}

// Route files under a pages dir whose path carries the forbidden segment.
function findDataMirrorRouteFiles(pagesDir: string): string[] {
    return listFiles(pagesDir)
        .filter((f) => ROUTE_EXT.test(f))
        .filter((f) => norm(f).includes(FORBIDDEN))
        .map(norm);
}

// Runtime source files (src/**, scripts/**) that textually reference the needle.
function findRuntimeRefs(dirs: string[], needle: string): string[] {
    const hits: string[] = [];
    for (const d of dirs) {
        for (const f of listFiles(d)) {
            if (!SRC_EXT.test(f)) continue;
            if (readFileSync(f, 'utf8').includes(needle)) hits.push(norm(f));
        }
    }
    return hits;
}

describe('data-mirror proxy route removal invariant (B1, D-180)', () => {
    it('the retired proxy route file is ABSENT under src/pages/ (=> public 404)', () => {
        expect(
            existsSync(abs(RETIRED_ROUTE)),
            `${RETIRED_ROUTE} must NOT exist: a routable file would be publicly reachable and proxy cdn.free2aitools.com with ACAO:*`,
        ).toBe(false);
    });

    it('NO replacement data-mirror route exists anywhere under src/pages/', () => {
        const offenders = findDataMirrorRouteFiles(abs('src/pages'));
        expect(offenders, `unexpected data-mirror route file(s): ${offenders.join(', ')}`).toEqual([]);
    });

    it('the route scan is NON-VACUOUS — it discovers real route files (proves it scanned)', () => {
        const routes = listFiles(abs('src/pages')).filter((f) => ROUTE_EXT.test(f));
        expect(routes.length, 'route scan found ZERO route files — detector is vacuous').toBeGreaterThan(0);
    });

    it('a missing routing root FAILS (fail-closed, not a silent pass)', () => {
        expect(existsSync(abs('src/pages')), 'src/pages must exist').toBe(true);
        expect(() => listFiles(abs('src/pages/__definitely_absent__'))).toThrow(/fail-closed/);
    });

    it('NO redirect/middleware authority recreates /data-mirror/* (read-only scan)', () => {
        const cfg = readFileSync(abs('astro.config.mjs'), 'utf8');
        expect(cfg, 'astro.config.mjs must not redirect/recreate /data-mirror').not.toContain(FORBIDDEN);
        const mw = readFileSync(abs('src/middleware.ts'), 'utf8');
        expect(mw, 'middleware must not rewrite/recreate /data-mirror').not.toContain(FORBIDDEN);
    });

    it('NO runtime source (src/**, scripts/**) references the retired data-mirror path', () => {
        const refs = findRuntimeRefs([abs('src'), abs('scripts')], FORBIDDEN);
        expect(refs, `runtime reference(s) to "${FORBIDDEN}": ${refs.join(', ')}`).toEqual([]);
    });

    it('ANTI-VACUITY: a synthetic reintroduction turns BOTH detectors RED', () => {
        const fixture = mkdtempSync(join(tmpdir(), 'dmrr-'));
        try {
            // Simulate a reintroduced proxy route under a fake pages dir.
            const pages = join(fixture, 'pages', 'data-mirror');
            mkdirSync(pages, { recursive: true });
            writeFileSync(join(pages, '[...path].ts'), 'export async function GET(){ return new Response(); }');
            // Simulate a runtime caller referencing the retired path.
            const src = join(fixture, 'src');
            mkdirSync(src, { recursive: true });
            writeFileSync(join(src, 'caller.ts'), 'export const u = "/data-mirror/x";');

            expect(
                findDataMirrorRouteFiles(join(fixture, 'pages')).length,
                'detector must flag a reintroduced data-mirror route file',
            ).toBeGreaterThan(0);
            expect(
                findRuntimeRefs([src], FORBIDDEN).length,
                'detector must flag a reintroduced runtime reference',
            ).toBeGreaterThan(0);
        } finally {
            rmSync(fixture, { recursive: true, force: true });
        }
    });
});
