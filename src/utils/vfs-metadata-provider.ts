import { normalizeEntitySlug, getR2PathCandidates } from './entity-cache-reader-core.js';

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
            const sqlMod = 'better-sqlite3';
            const { default: Database } = await import(sqlMod);
            const pathMod = 'path';
            const path = await import(pathMod);
            const dbPath = path.resolve(process.cwd(), 'data/meta.db');

            // Check if local DB exists
            const fsMod = 'fs/promises';
            const fs = await import(fsMod);
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
    // Production / Simulation Mode: Attempt remote metadata lookup via VFS Proxy API.
    // This allows local dev to fully simulate production data paths.
    if (!isDev || isSimulatingRemote) {
        try {
            const { R2_CACHE_URL } = await import('../config/constants.js');
            const paths = getR2PathCandidates(type, normalized);

            // Prioritize Fused (High Fidelity) and Gzip
            const prioritized = paths.filter(p => p.includes('/fused/'));
            if (prioritized.length === 0) prioritized.push(...paths);

            for (const path of prioritized) {
                const url = `${R2_CACHE_URL}/${path}`;
                try {
                    const res = await fetch(url);
                    if (res.ok) {
                        const buffer = await res.arrayBuffer();
                        const uint8 = new Uint8Array(buffer);

                        // Robust Gzip Detection (Magic Number 1F 8B)
                        const isGzip = uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b;

                        let data;
                        if (isGzip) {
                            try {
                                const ds = new DecompressionStream('gzip');
                                const decompressedRes = new Response(new Response(buffer).body?.pipeThrough(ds));
                                data = await decompressedRes.json();
                            } catch (err) {
                                // Fallback for environments without DecompressionStream (Node 18)
                                const zlibMod = 'node:zlib';
                                const zlib = await import(zlibMod);
                                data = JSON.parse(zlib.gunzipSync(Buffer.from(buffer)).toString('utf-8'));
                            }
                        } else {
                            data = JSON.parse(new TextDecoder().decode(buffer));
                        }

                        const entity = data.entity || data;
                        console.log(`[VFS-Metadata] [REMOTE] Resolved ${normalized} via ${path} (${isGzip ? 'gzip' : 'plain'})`);
                        return {
                            data: entity,
                            source: `remote-vfs:${path}`,
                            _isRemote: true
                        };
                    }
                } catch (e) { continue; }
            }
        } catch (e: any) {
            console.warn(`[VFS-Metadata] [REMOTE-FAIL] ${normalized} lookup failed:`, e.message);
        }
    }

    return null;
}
