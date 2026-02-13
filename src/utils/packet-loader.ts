import { R2_CACHE_URL } from '../config/constants.js';
import { getR2PathCandidates, normalizeEntitySlug, fetchEntityFromR2 } from './entity-cache-reader-core.js';

/**
 * V16.5 Smart Packet Loader (Entity-First Anchored Strategy)
 * 
 * Strategy (V16.8.3):
 * 1. Generate robust candidates using `getR2PathCandidates`.
 * 2. Find the ENTITY metadata first (The Anchor).
 * 3. Use the Entity's authoritative ID to fetch Fused/Mesh streams.
 * 
 * This solves the "Prefix Mismatch" issue where:
 * - URL: `meta-llama/llama-3-8b` (Short)
 * - Storage: `hf-model--meta-llama--llama-3-8b` (Prefixed)
 * - Loader was guessing wrong paths.
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

    // 2. Initial Discovery (Broad)
    const candidates = getR2PathCandidates(type, normalized);

    // 3. Entity-First Discovery Strategy (V16.8.3 Stable)
    // To prevent "Chaos" and 404s, we MUST find the Entity Metadata first.
    // The Entity's internal ID is the Source of Truth for all other data streams.

    // Step A: Find the Entity Metadata (The Anchor)
    const entityCandidates = candidates.filter(c => c.includes('/entities/'));

    // Also try "fused" paths as entity sources because V18.2 packets often combine them
    // But we strictly look for the "entity" property inside them if we go that route.
    const fusedAsEntityCandidates = candidates.filter(c => c.includes('/fused/'));

    let entityPack = null;
    let entitySourcePath = null;

    // A.1 Try Pure Entity Paths First (Fastest, Metadata Only)
    // We iterate sequentially because we need the *correct* one, not just *any* one.
    const findFirst = async (list: string[]) => {
        for (const p of list) {
            const data = await fetchCompressedJSON(p);
            if (data) return { data, path: p };
        }
        return null;
    };

    const entityResult = await findFirst(entityCandidates);
    if (entityResult) {
        entityPack = entityResult.data;
        entitySourcePath = entityResult.path;
    }

    // A.2 If not found, try Fused Paths (Fallback)
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

    // 4. Validate Core Entity (The Gatekeeper)
    if (!entityPack) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, source: '404' } };
    }

    // --- ANCHOR ESTABLISHED ---
    // We now have the Canonical ID from the Entity itself.
    const canonicalId = entityPack.id || entityPack.slug || slug;

    // Step B: Fetch Secondary Streams using Canonical ID
    // We must re-normalize to ensure we generated the correct path for Fused/Mesh
    const normalizedCanonical = normalizeEntitySlug(canonicalId, type);
    const canonicalCandidates = getR2PathCandidates(type, normalizedCanonical);

    const fusedCandidates = canonicalCandidates.filter(c => c.includes('/fused/'));
    const meshCandidates = canonicalCandidates.map(c => c.replace('/entities/', '/mesh/profiles/').replace('/fused/', '/mesh/profiles/'));

    // Parallel Fetch for Secondary Content (now targeted correctly)
    const [fusedResult, meshResult] = await Promise.all([
        findFirst(fusedCandidates),
        findFirst(meshCandidates.slice(0, 2))
    ]);

    const fusedPack = fusedResult?.data;
    const meshPack = meshResult?.data;

    // 5. Assemble Data
    const entity = entityPack;

    // Stream B Extraction (HTML)
    let html = null;
    if (fusedPack) {
        html = fusedPack.html || fusedPack.html_readme || (fusedPack.entity ? fusedPack.entity.html_readme : null);
    }

    // Stream C Extraction (Mesh)
    // V16.8.3 FIX: Use raw nodes from mesh pack or fallback to fused
    let mesh = [];
    if (meshPack && meshPack.nodes) {
        mesh = meshPack.nodes;
    } else if (meshPack && meshPack.data && meshPack.data.nodes) {
        // Handle wrapped format just in case
        mesh = meshPack.data.nodes;
    } else if (fusedPack && fusedPack.mesh_profile) {
        mesh = fusedPack.mesh_profile.nodes || fusedPack.mesh_profile || [];
    }

    return {
        entity,
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
