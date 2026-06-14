/**
 * vfs-metadata dead-route removal invariant (P-06).
 *
 * src/pages/api/vfs-metadata.ts was a public Astro ROUTE that returned HTTP 501
 * ("VFS Search not yet implemented on server") UNCONDITIONALLY, had ZERO known
 * route consumers, and was never part of the public contract (absent from
 * OpenAPI). It was a dead stub. P-06 deletes it; with no route file under
 * src/pages/api/, Astro cannot route the path, so a public request to
 * /api/vfs-metadata returns HTTP 404 (structural) — the required behavior.
 *
 * CRITICAL DISTINCTION (locked by this guard): the deleted item is the dead
 * ROUTE (src/pages/api/vfs-metadata.ts). The VFS metadata PROVIDER util
 * (src/utils/vfs-metadata-provider.ts) is a DIFFERENT module with real
 * consumers (packet-loader, entity API, etc.) and MUST remain present. This
 * test asserts both halves so the route cannot reappear and the provider util
 * is never collaterally removed.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);

describe('vfs-metadata dead-route removal invariant (P-06)', () => {
    it('the dead 501 route file does NOT exist under src/pages/api/ (=> public 404)', () => {
        expect(
            existsSync(abs('src/pages/api/vfs-metadata.ts')),
            'src/pages/api/vfs-metadata.ts must NOT exist: a routable file would be publicly reachable; the dead 501 stub is removed',
        ).toBe(false);
    });

    it('the VFS metadata PROVIDER util remains present (different module, has real consumers)', () => {
        expect(
            existsSync(abs('src/utils/vfs-metadata-provider.ts')),
            'src/utils/vfs-metadata-provider.ts must remain: it is the provider util with real consumers (NOT the dead route)',
        ).toBe(true);
    });
});
