import { normalizeEntitySlug, getR2PathCandidates } from './entity-cache-reader-core.js';
// V26.0: Astro 6 migration — use cloudflare:workers instead of locals.runtime.env
import { env } from 'cloudflare:workers';

/**
 * VFS Metadata Provider (V22.8)
 * 
 * Provides 100% JSON-free metadata resolution via SQLite Range Queries.
 * Dual-Mode Enforcement (Art 2.1):
 * - Local Testing: 100% SQLite (meta.db) -> Fails if missing.
 * - Production: VFS-Primary (Range Read) -> Fallback allowed if R2 severed.
 */

export async function resolveVfsMetadata(type: string, slug: string, locals: any = null) {
    const isDev = !!(process.env.NODE_ENV === 'development' || import.meta.env?.DEV);
    const isSimulatingRemote = !!(typeof process !== 'undefined' && process.env.SIMULATE_PRODUCTION);
    console.log(`[VFS-DEBUG] isDev=${isDev}, isSimulatingRemote=${isSimulatingRemote}`);
    const normalized = normalizeEntitySlug(slug, type).toLowerCase();

    // Strategy 1: Local Development (better-sqlite3)
    // STRICTOR LOCAL VFS MANDATE: Fails if DB not found, forbidden JSON fallback locally.
    if (isDev && typeof window === 'undefined' && !isSimulatingRemote) {
        try {
            const { default: Database } = await import('better-sqlite3');
            const path = await import('path');
            const dbPath = path.resolve(process.cwd(), 'data/meta.db');

            // Check if local DB exists
            const fs = await import('fs/promises');
            const exists = await fs.stat(dbPath).catch(() => null);

            if (exists) {
                const db = new Database(dbPath, { readonly: true });
                const row = db.prepare('SELECT * FROM entities WHERE id = ? OR slug = ?').get(normalized, normalized);
                db.close();

                if (row) {
                    console.log(`[VFS-Metadata] [LOCAL] Resolved ${normalized} via strict SQLite`);
                    return { data: row, source: 'local-sqlite' };
                }
            } else {
                console.error(`[VFS-Metadata] [LOCAL-ERROR] meta.db missing at ${dbPath}. Strict VFS Mandate VIOLATED.`);
                // In local dev, we throw to prevent hidden JSON fallbacks
                throw new Error('VFS-Primary Violation: Local meta.db not found.');
            }
        } catch (e: any) {
            console.warn('[VFS-Metadata] [LOCAL-FAIL]', e.message);
            throw e; // Propagate failure in dev
        }
    }

    // Strategy 2: Remote/Production VFS Proxy (SQLite Range Query / site_metadata)
    // Production / Simulation Mode: Attempt remote metadata lookup via R2 binding directly on server
    if (!isDev || isSimulatingRemote) {
        // V26.0: env imported from cloudflare:workers at module level
        const r2 = env?.R2_ASSETS;
        const { R2_CACHE_URL } = await import('../config/constants.js');
        const paths = getR2PathCandidates(type, normalized);

        // Prioritize Fused (High Fidelity) and Gzip
        const prioritized = paths.filter(p => p.includes('/fused/'));
        if (prioritized.length === 0) prioritized.push(...paths);

        for (const path of prioritized) {
            try {
                let data: any = null;
                let source = '';

                // Tier 1: R2 Binding (High Reliability for Workers)
                if (r2 && typeof window === 'undefined') {
                    const file = await r2.get(path);
                    if (file) {
                        if (path.endsWith('.gz')) {
                            const ds = new DecompressionStream('gzip');
                            const decompressedStream = file.body.pipeThrough(ds);
                            data = await new Response(decompressedStream).json();
                        } else {
                            data = await file.json();
                        }
                        source = `r2-binding:${path}`;
                    }
                }

                // Tier 2: CDN Fetch (Fallback/Browser)
                if (!data) {
                    const url = `${R2_CACHE_URL}/${path}`;
                    const res = await fetch(url);
                    if (res.ok) {
                        const buffer = await res.arrayBuffer();
                        const uint8 = new Uint8Array(buffer);
                        const isGzip = uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b;

                        if (isGzip) {
                            try {
                                const ds = new DecompressionStream('gzip');
                                const decompressedRes = new Response(new Response(buffer).body?.pipeThrough(ds));
                                data = await decompressedRes.json();
                            } catch (err) {
                                const zlib = await import('node:zlib');
                                data = JSON.parse(zlib.gunzipSync(Buffer.from(buffer)).toString('utf-8'));
                            }
                        } else {
                            data = JSON.parse(new TextDecoder().decode(buffer));
                        }
                        source = `remote-fetch:${path}`;
                    }
                }

                if (data) {
                    const entity = data.entity || data;
                    console.log(`[VFS-Metadata] Resolved ${normalized} via ${source}`);
                    return {
                        data: entity,
                        source: source,
                        _isRemote: true
                    };
                }
            } catch (e) { continue; }
        }
    }

    return null;
}
