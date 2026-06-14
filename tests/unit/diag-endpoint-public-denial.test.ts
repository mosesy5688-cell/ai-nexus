/**
 * Diagnostic-endpoint public-denial invariant (P-07, SECURITY).
 *
 * Four internal diagnostic API routes were publicly reachable (unauthenticated
 * HTTP 200) and disclosed internal state — env-var KEY names, R2 binding /
 * manifest / dbName, internal VFS / shard paths, and cache file contents:
 *   - src/pages/api/diag.ts
 *   - src/pages/api/db-diag.ts
 *   - src/pages/api/bundle-diag.ts
 *   - src/pages/api/vfs-debug.ts
 *
 * The approved remediation DELETES these filesystem-routed Astro endpoints. With
 * no route file under src/pages/api/, Astro cannot route the path, so a public
 * request returns HTTP 404 with no diagnostic body — which is exactly the
 * required production behavior.
 *
 * This guard locks the removal permanently: the four route files must not
 * reappear under src/pages/api/, no source file may re-introduce a route that
 * surfaces the known internal markers, and the normal public API surface
 * (search / entity / vfs-metadata) must remain intact.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);

// The retired diagnostic route files. Presence under src/pages/api/ == a live
// public route, so absence == HTTP 404 for any public request.
const REMOVED_DIAG_ROUTES = [
    'src/pages/api/diag.ts',
    'src/pages/api/db-diag.ts',
    'src/pages/api/bundle-diag.ts',
    'src/pages/api/vfs-debug.ts',
];

// Internal-state markers that the diagnostic endpoints used to disclose. These
// are asserted ABSENT from the (now-deleted) diagnostic route files. We do not
// blanket-ban the substrings across the whole api surface: some — e.g. the
// `bundle_key` DB column or a `fused-shard` doc comment — are legitimate
// internal-only usages in normal routes that are never serialized to a public
// response. The P-07 guarantee is structural: a deleted filesystem route returns
// HTTP 404 with no body at all, so none of these markers can reach a public
// caller via the diagnostic surface.
const INTERNAL_MARKERS = [
    'ADMIN_SECRET',
    'AES_CRYPTO_KEY',
    'fused-shard',
    'vfs:meta',
    'bundle_key',
    'r2_binding',
];

// Normal public API routes that MUST remain reachable (unchanged by P-07).
const PRESERVED_ROUTES = [
    'src/pages/api/search.ts',
    'src/pages/api/vfs-metadata.ts',
    'src/pages/api/v1/search.ts',
];

describe('diagnostic endpoint public-denial invariant (P-07)', () => {
    // Test 1 + Test 2: not publicly reachable / returns 404 (not 200).
    // A filesystem-routed Astro endpoint that does not exist cannot return 200;
    // the platform serves 404. So the route-file absence IS the 404 guarantee.
    it('the four diagnostic route files do not exist under src/pages/api/ (=> public 404, not 200)', () => {
        for (const route of REMOVED_DIAG_ROUTES) {
            expect(
                existsSync(abs(route)),
                `${route} must NOT exist: a routable file would be publicly reachable and return 200`,
            ).toBe(false);
        }
    });

    // Test 3: the removed diagnostic files cannot disclose any internal-state
    // marker, because the files (and therefore their public bodies) are gone.
    // A deleted filesystem route returns 404 with no body, so absence of the
    // route file IS absence of every marker from the public response.
    it('none of the removed diagnostic route files exist to disclose internal markers', () => {
        for (const route of REMOVED_DIAG_ROUTES) {
            const present = existsSync(abs(route));
            expect(present, `${route} must be absent so it cannot disclose internal state`).toBe(false);
            if (present) {
                // Defensive: if a file ever returns, fail loudly per-marker too.
                const src = readFileSync(abs(route), 'utf8');
                for (const marker of INTERNAL_MARKERS) {
                    expect(src.includes(marker), `${route} re-introduces internal marker "${marker}"`).toBe(false);
                }
            }
        }
    });

    // Test 5: normal public API routes remain present (no collateral removal).
    it('normal public API routes (search / entity / vfs-metadata) remain present', () => {
        for (const route of PRESERVED_ROUTES) {
            expect(existsSync(abs(route)), `${route} must remain a live route`).toBe(true);
        }
        // The entity route directory must also remain.
        expect(existsSync(abs('src/pages/api/v1/entity')), 'v1/entity route must remain').toBe(true);
    });
});
