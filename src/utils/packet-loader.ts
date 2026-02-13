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

    // 2. Define Stream Paths (SPEC-ID-PREFIX-V16.5 Standard)
    // Logic: URL is clean (Short), Storage is prefixes (Full ID).
    // Formula: {source_prefix}-{type_prefix}--{owner}--{name}

    // Prefix Mapping Table (Source: SPEC-ID-PREFIX-V16.5)
    const prefixMap: Record<string, string> = {
        'model': 'hf-model--',
        'space': 'hf-space--',
        'dataset': 'hf-dataset--',
        'agent': 'gh-agent--',   // Standardizing on GitHub for Agents per Spec
        'tool': 'gh-tool--',     // Standardizing on GitHub for Tools per Spec
        'paper': 'arxiv-paper--'
    };

    // Ensure slug has the correct prefix for storage lookups
    // normalizeEntitySlug() strips prefixes, so we must re-attach the authoritative one.
    const prefix = prefixMap[type] || '';
    const storageSlug = normalized.startsWith(prefix) ? normalized : `${prefix}${normalized}`;

    // Stream A: Entity Metadata
    // Path: entities/{type}/{storage_id}.json
    const entityPath = `entities/${type}/${storageSlug}.json`;

    // Stream B: Fused Content
    // Fused packets use the Flattened ID: fused/{storage_id}.json
    const fusedPath = `fused/${storageSlug}.json`;

    // Stream C: Mesh Profile
    // Mesh profiles use the Flattened ID: mesh/profiles/{storage_id}.json
    const meshPath = `mesh/profiles/${storageSlug}.json`;

    try {
        // 3. Parallel Fetch (The "Static Assembly" Core)
        const [entityPack, fusedPack, meshPack] = await Promise.all([
            fetchCompressedJSON(entityPath),  // Stream A
            fetchCompressedJSON(fusedPath),   // Stream B
            fetchCompressedJSON(meshPath)     // Stream C
        ]);

        // 4. Validate Core Entity (Stream A)
        // If Stream A fails, the page cannot exist.
        if (!entityPack) {
            // Fallback: Try Fused Packet as Entity Source (Migration Phase Compat)
            if (fusedPack && (fusedPack.entity || fusedPack.id)) {
                const entity = fusedPack.entity || fusedPack;
                return {
                    entity,
                    html: fusedPack.html || fusedPack.html_readme || entity.html_readme || null,
                    mesh: meshPack?.nodes || fusedPack.mesh_profile?.nodes || [],
                    _meta: { available: true, source: 'fused-fallback', isFused: true }
                };
            }
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
        let mesh = [];
        if (meshPack && meshPack.nodes) {
            mesh = meshPack.nodes;
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
                source: '3-stream-assembly',
                streams: {
                    entity: !!entityPack,
                    html: !!fusedPack,
                    mesh: !!meshPack
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
