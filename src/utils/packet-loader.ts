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
            if (!res.ok) {
                continue;
            }

            // V16.8.4 FIX: Improved Safe Decode Strategy for SSR/Client Consistency
            const buffer = await res.arrayBuffer();
            const uint8 = new Uint8Array(buffer);

            // AUTO-DETECT: Check for GZIP Magic Bytes (0x1f 0x8b)
            const isActuallyGzip = uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b;

            if (isActuallyGzip) {
                try {
                    // Try decompression using available API
                    if (typeof globalThis.DecompressionStream === 'undefined' && typeof process !== 'undefined') {
                        const { gunzipSync } = await import('node:zlib');
                        const decompressed = gunzipSync(uint8);
                        return JSON.parse(new TextDecoder().decode(decompressed));
                    } else {
                        const ds = new DecompressionStream('gzip');
                        const writer = ds.writable.getWriter();
                        writer.write(buffer);
                        writer.close();
                        const output = new Response(ds.readable);
                        return await output.json();
                    }
                } catch (gzipError) {
                    console.warn(`[SSR] Decompression failed for ${url} despite Gzip header. Falling back to text parse.`);
                    // Fallback: If decompression fails, it might be a corrupted or fake Gzip
                    try {
                        const text = new TextDecoder().decode(buffer);
                        return JSON.parse(text);
                    } catch (jsonError) {
                        return null;
                    }
                }
            } else {
                // Not GZIP: Parse as Plain JSON
                try {
                    const text = new TextDecoder().decode(buffer);
                    return JSON.parse(text);
                } catch (jsonError) {
                    // Fail silently, try next candidate
                }
            }
        } catch (e) {
            // Network or fetch error
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
    // 4. Secondary Stream Discovery (Fused & Mesh) - V16.8.6 Prefix-Aware Pathing
    const rawId = entityPack.id || entityPack.slug || slug;
    const canonicalId = normalizeEntitySlug(rawId, type);

    // Use getR2PathCandidates to get prefix-aware paths for Fused and Mesh
    const secondaryCandidates = getR2PathCandidates(type, canonicalId);

    const fusedPath = secondaryCandidates.find(c => c.includes('/fused/')) || `cache/fused/${canonicalId}.json.gz`;
    const meshPath = `cache/mesh/profiles/${canonicalId}.json.gz`;

    // Attempt to fetch Fused Pack (README/HTML)
    let fusedPack = await fetchCompressedJSON(fusedPath);
    if (!fusedPack && !fusedPath.endsWith('.gz')) {
        fusedPack = await fetchCompressedJSON(`${fusedPath}.gz`);
    }

    // --- DATA FUSION (V16.8.8) ---
    // Merge fused metadata into entity metadata (Fidelity Restoration)
    if (fusedPack) {
        const { html_readme, ...fusedMeta } = fusedPack;

        // Aliases for HTML content (Normalize Stream B)
        const html = html_readme || fusedPack.body || fusedPack.content_html || fusedPack.readme_html || entityPack.html_readme || null;

        // Perform Shallow Merge (Favouring Fused for technical metrics)
        Object.assign(entityPack, {
            ...fusedMeta,
            html_readme: html,
            // Guard: Never let a tiny summary overwrite a real README
            description: entityPack.description?.length > 500 ? entityPack.description : (fusedMeta.description || entityPack.description)
        });
    }

    // Attempt to fetch Mesh Pack (Relations)
    let meshPack = await fetchCompressedJSON(meshPath);
    if (!meshPack) meshPack = await fetchCompressedJSON(`${meshPath.replace('.gz', '')}`);
    if (!meshPack && !meshPath.endsWith('.gz')) meshPack = await fetchCompressedJSON(`${meshPath}.gz`);

    const mesh = meshPack?.relations || meshPack?.nodes || entityPack.relations || [];
    const finalHtml = entityPack.html_readme || null;

    return {
        entity: entityPack,
        html: finalHtml,
        mesh,
        _meta: {
            available: true,
            source: 'entity-first-anchored',
            streams: {
                entity: true,
                html: !!finalHtml,
                mesh: !!mesh
            },
            paths: {
                entity: entitySourcePath,
                fused: finalHtml ? fusedPath : 'missing',
                mesh: mesh ? meshPath : 'missing'
            }
        }
    };
}
