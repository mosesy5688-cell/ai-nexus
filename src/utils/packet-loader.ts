import { R2_CACHE_URL } from '../config/constants.js';
import { getR2PathCandidates, normalizeEntitySlug } from './entity-cache-reader-core.js';

/**
 * V16.5 Smart Packet Loader (Entity-First Anchored Strategy)
 * 
 * Strategy (V16.8.3):
 * 1. Generate robust candidates using `getR2PathCandidates`.
 * 2. Find the ENTITY metadata first (The Anchor).
 * 3. Use the Entity's authoritative ID to fetch Fused/Mesh streams.
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
            const uint8 = new Uint8Array(buffer);

            // AUTO-DETECT: Check for GZIP Magic Bytes (0x1f 0x8b)
            const isActuallyGzip = uint8[0] === 0x1f && uint8[1] === 0x8b;

            if (isActuallyGzip) {
                try {
                    // 1. Try GZIP Decompression
                    if (typeof globalThis.DecompressionStream === 'undefined' && typeof process !== 'undefined') {
                        const { gunzipSync, unzipSync } = await import('node:zlib');
                        try {
                            const decompressed = gunzipSync(uint8);
                            return JSON.parse(new TextDecoder().decode(decompressed));
                        } catch (e1) {
                            const decompressed2 = unzipSync(uint8);
                            return JSON.parse(new TextDecoder().decode(decompressed2));
                        }
                    } else {
                        const ds = new DecompressionStream('gzip');
                        const writer = ds.writable.getWriter();
                        writer.write(buffer);
                        writer.close();
                        const output = new Response(ds.readable);
                        return await output.json();
                    }
                } catch (gzipError) {
                    // If decompression fails despite magic bytes, try text fallback
                    try {
                        const text = new TextDecoder().decode(buffer);
                        return JSON.parse(text);
                    } catch (jsonError) {
                        return null;
                    }
                }
            } else {
                // 2. Not GZIP: Parse as Plain JSON
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
 */
export async function loadEntityStreams(type: string, slug: string) {
    const normalized = normalizeEntitySlug(slug, type);
    const candidates = getR2PathCandidates(type, normalized);

    // Step A: Find the Entity Metadata (The Anchor)
    const entityCandidates = candidates.filter(c => c.includes('/entities/'));
    const fusedAsEntityCandidates = candidates.filter(c => c.includes('/fused/'));

    let entityPack = null;
    let entitySourcePath = null;

    const findFirst = async (list: string[]) => {
        for (const p of list) {
            const data = await fetchCompressedJSON(p);
            if (data) return { data, path: p };
        }
        return null;
    };

    // A.1 Try Entity Paths
    const entityResult = await findFirst(entityCandidates);
    if (entityResult) {
        entityPack = entityResult.data;
        entitySourcePath = entityResult.path;
    }

    // A.2 Try Fused Paths if metadata missing
    if (!entityPack) {
        const fusedResult = await findFirst(fusedAsEntityCandidates);
        if (fusedResult) {
            const data = fusedResult.data;
            if (data.entity || data.id) {
                entityPack = data.entity || data;
                entitySourcePath = fusedResult.path;
            }
        }
    }

    if (!entityPack) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, source: '404' } };
    }

    // --- ANCHOR ESTABLISHED ---
    const canonicalId = entityPack.id || entityPack.slug || slug;
    const normalizedCanonical = normalizeEntitySlug(canonicalId, type);
    const canonicalCandidates = getR2PathCandidates(type, normalizedCanonical);

    const fusedCandidates = canonicalCandidates.filter(c => c.includes('/fused/'));
    const meshCandidates = canonicalCandidates.map(c => c.replace('/entities/', '/mesh/profiles/').replace('/fused/', '/mesh/profiles/'));

    // Parallel Fetch for Content
    const [fusedResult, meshResult] = await Promise.all([
        findFirst(fusedCandidates),
        findFirst(meshCandidates.slice(0, 2))
    ]);

    const fusedPack = fusedResult?.data;
    const meshPack = meshResult?.data;

    // Stream B (HTML)
    let html = null;
    if (fusedPack) {
        html = fusedPack.html || fusedPack.html_readme || (fusedPack.entity ? fusedPack.entity.html_readme : null);
    }

    // Stream C (Mesh)
    let mesh = [];
    if (meshPack && (meshPack.nodes || meshPack.data?.nodes)) {
        mesh = meshPack.nodes || meshPack.data?.nodes;
    } else if (fusedPack && fusedPack.mesh_profile) {
        mesh = fusedPack.mesh_profile.nodes || fusedPack.mesh_profile || [];
    }

    return {
        entity: entityPack,
        html,
        mesh,
        _meta: {
            available: true,
            source: 'entity-first-anchored',
            streams: {
                entity: true,
                html: !!fusedPack,
                mesh: !!meshPack
            },
            paths: {
                entity: entitySourcePath,
                fused: fusedResult?.path || 'missing',
                mesh: meshResult?.path || 'missing'
            }
        }
    };
}
