import { R2_CACHE_URL } from '../config/constants.js';
import { getR2PathCandidates, normalizeEntitySlug, fetchEntityFromR2 } from './entity-cache-reader-core.js';

/**
 * V16.5 Smart Packet Loader (Prefix-Aware Single-Stream)
 * 
 * Strategy:
 * 1. Generate robust candidates (e.g. `hf-agent--...`, `gh-agent--...`) using `getR2PathCandidates`.
 * 2. Fetch the "Fused Packet" (contains Metadata + HTML + Mesh) from `cache/fused`.
 * 3. Fallback to `cache/entities` (Metadata Only) if Fused is missing.
 */

// Universal Gzip Fetcher (Robust Buffer Strategy)
export async function fetchCompressedJSON(path: string): Promise<any | null> {
    const fullUrl = path.startsWith('http') ? path : `${R2_CACHE_URL}/${path}`;
    // V18.2: R2 Gzip Handling - PRIORITIZE .gz to eliminate 404 overhead
    const candidates = fullUrl.endsWith('.gz') ? [fullUrl] : [`${fullUrl}.gz`, fullUrl];

    for (const url of candidates) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;

            // V16.8.2 FIX: Always use ArrayBuffer to handle ambiguous GZIP/JSON states
            const buffer = await res.arrayBuffer();

            // 1. Try GZIP Decompression first (Most likely for R2 assets)
            try {
                // Isomorphic Decompression
                if (typeof globalThis.DecompressionStream === 'undefined' && typeof process !== 'undefined') {
                    const { gunzipSync, unzipSync } = await import('node:zlib');
                    // Try gunzip first
                    try {
                        const decompressed = gunzipSync(new Uint8Array(buffer));
                        return JSON.parse(new TextDecoder().decode(decompressed));
                    } catch (e1) {
                        // Fallback to unzip/inflate just in case
                        const decompressed2 = unzipSync(new Uint8Array(buffer));
                        return JSON.parse(new TextDecoder().decode(decompressed2));
                    }
                } else {
                    // Browser/Worker path
                    const ds = new DecompressionStream('gzip');
                    const writer = ds.writable.getWriter();
                    writer.write(buffer);
                    writer.close();
                    const output = new Response(ds.readable);
                    return await output.json();
                }
            } catch (gzipError) {
                // 2. Fallback: Parse as Plain JSON (TextDecoder)
                // This catches cases where file is uncompressed but was processed as binary
                try {
                    const text = new TextDecoder().decode(buffer);
                    return JSON.parse(text);
                } catch (jsonError) {
                    // console.warn(`[PacketLoader] Failed to parse ${url}: Not GZIP and Not JSON.`);
                }
            }
        } catch (e) {
            // Network error
        }
    }
    return null;
}

/**
 * V16.5 Static Assembly Loader (3-Stream Parallel Fetch)
 * 
 * Architecture:
 * - Stream A (Entity): cache/entities/{type}/{slug} (Required)
 * - Stream B (DeepDive): cache/fused/{slug} (Read-Only HTML Content) (Optional)
 * - Stream C (Mesh): cache/mesh/profiles/{slug} (Deep Relations) (Optional)
 */
export async function loadEntityStreams(type: string, slug: string) {
    // 1. Normalize Slug
    const normalized = normalizeEntitySlug(slug, type);

    // 2. Robust Path Discovery (V16.8.2 Hotfix)
    // Instead of enforcing a strict prefix (which caused 404s), we generate ALL possible candidates
    // and try them in parallel or sequence. This honors "Stable URLs" by supporting legacy and new storage keys.
    const candidates = getR2PathCandidates(type, normalized);

    // We need to find:
    // A. The Entity Data (Metadata)
    // B. The Fused Data (HTML/Mesh) - often mixed with Entity in V18.2 "Fused" packets

    // Helper to find the first existing path from a list of candidates
    const findFirstExisting = async (pCandidates: string[]): Promise<{ data: any, path: string } | null> => {
        for (const p of pCandidates) {
            const data = await fetchCompressedJSON(p);
            if (data) return { data, path: p };
        }
        return null;
    };

    // Strategy:
    // 1. Try "Fused" paths first (most efficient, contains E+H+M)
    // 2. Try "Entity" paths second (metadata only)

    const fusedCandidates = candidates.filter(c => c.includes('/fused/'));
    const entityCandidates = candidates.filter(c => c.includes('/entities/'));
    const meshCandidates = candidates.map(c => c.replace('/entities/', '/mesh/profiles/').replace('/fused/', '/mesh/profiles/'));

    try {
        // 3. Parallel Discovery (The "Dynamic Assembly" Core)
        // We try to fetch the best available packet for each stream
        const [fusedResult, entityResult, meshPack] = await Promise.all([
            findFirstExisting(fusedCandidates),
            findFirstExisting(entityCandidates),
            findFirstExisting(meshCandidates.slice(0, 2)) // Only check top 2 mesh paths to save ops
        ]);

        const fusedPack = fusedResult?.data;
        const entityPack = entityResult?.data || (fusedPack?.entity ? fusedPack.entity : (fusedPack?.id ? fusedPack : null));

        // 4. Validate Core Entity
        if (!entityPack) {
            return { entity: null, html: null, mesh: null, _meta: { available: false, source: '404' } };
        }

        // 5. Assemble Data
        const entity = entityPack;

        // Stream B Extraction (HTML)
        // Prefer explicit HTML packet, fallback to entity's own field if missing
        let html = null;
        if (fusedPack) {
            html = fusedPack.html || fusedPack.html_readme || (fusedPack.entity ? fusedPack.entity.html_readme : null);
        }

        // Stream C Extraction (Mesh)
        // V16.8.2 FIX: Unwrap the 'data' property from findFirstExisting result
        let mesh = [];
        if (meshPack && meshPack.data && meshPack.data.nodes) {
            mesh = meshPack.data.nodes;
        } else if (fusedPack && fusedPack.mesh_profile) {
            // Fallback to fused mesh if dedicated stream missing
            mesh = fusedPack.mesh_profile.nodes || fusedPack.mesh_profile || [];
        }

        return {
            entity,
            html,
            mesh,
            _meta: {
                available: true,
                source: '3-stream-discovery', // Updated source name
                streams: {
                    entity: !!entityPack,
                    html: !!fusedPack,
                    mesh: !!meshPack
                },
                // V16.8.2: Debug Info - Report which paths were actually used
                paths: {
                    entity: entityResult?.path || 'fallback',
                    fused: fusedResult?.path || 'missing',
                    mesh: meshPack?.path || 'fallback'
                }
            }
        };

    } catch (e) {
        console.error(`[PacketLoader] Stream Assembly Failed for ${slug}:`, e);
        return {
            entity: null,
            html: null,
            mesh: null,
            _meta: { available: false, source: 'error', error: (e as any).message }
        };
    }
}
