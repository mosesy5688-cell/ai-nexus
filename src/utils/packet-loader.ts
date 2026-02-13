import { R2_CACHE_URL } from '../config/constants.js';
import { getR2PathCandidates, normalizeEntitySlug } from './entity-cache-reader-core.js';

/**
 * V16.5 Smart Packet Loader (Prefix-Aware Single-Stream)
 * 
 * Strategy:
 * 1. Generate robust candidates (e.g. `hf-agent--...`, `gh-agent--...`) using `getR2PathCandidates`.
 * 2. Fetch the "Fused Packet" (contains Metadata + HTML + Mesh) from `cache/fused`.
 * 3. Fallback to `cache/entities` (Metadata Only) if Fused is missing.
 */

// Universal Gzip Fetcher
export async function fetchCompressedJSON(path: string): Promise<any | null> {
    const fullUrl = path.startsWith('http') ? path : `${R2_CACHE_URL}/${path}`;

    // V18.2: R2 Gzip Handling - PRIORITIZE .gz to eliminate 404 overhead
    const candidates = fullUrl.endsWith('.gz') ? [fullUrl] : [`${fullUrl}.gz`, fullUrl];

    for (const url of candidates) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                // If browser handled decompression (transparent), just json()
                // If not (e.g. raw .gz file body), use DecompressionStream
                const isGzipHeader = res.headers.get('Content-Encoding') === 'gzip';
                const isGzipFile = url.endsWith('.gz');

                // V16.5.14 FIX: Use ArrayBuffer to avoid "body stream already read" and allow retry
                if (isGzipFile && !isGzipHeader) {
                    let buffer;
                    try {
                        buffer = await res.arrayBuffer();

                        // V16.6.2: Isomorphic Decompression (SSR Compatibility)
                        if (typeof globalThis.DecompressionStream === 'undefined' && typeof process !== 'undefined') {
                            const { gunzipSync } = await import('node:zlib');
                            const decompressed = gunzipSync(new Uint8Array(buffer));
                            return JSON.parse(new TextDecoder().decode(decompressed));
                        }

                        // Browser/Worker path
                        const ds = new DecompressionStream('gzip');
                        const writer = ds.writable.getWriter();
                        writer.write(buffer);
                        writer.close();
                        const output = new Response(ds.readable);
                        return await output.json();
                    } catch (e) {
                        // Fallback: Buffer might be plain JSON (R2 auto-switched or decompression failed)
                        if (buffer) {
                            try {
                                const text = new TextDecoder().decode(buffer);
                                return JSON.parse(text);
                            } catch (e2: any) {
                                console.error(`[PacketLoader] Decompression/Parse failed for ${url}:`, e2.message);
                            }
                        }
                        return null;
                    }
                }

                return await res.json();
            }
        } catch (e) {
            // Network error or 404
        }
    }
    return null;
}

// Single-Stream Orchestrator
export async function loadEntityPack(type: string, slug: string) {
    // 1. Generate Candidate Paths (Prefix-Aware)
    // V16.5.2 HOTFIX: Must normalize slug (convert / to --) to match R2 keys!
    const normalized = normalizeEntitySlug(slug, type);

    // This handles the `hf-agent--` vs `gh-agent--` ambiguity automatically
    // It returns paths like `cache/fused/gh-agent--...`, `cache/entities/...`
    const candidates = getR2PathCandidates(type, normalized);

    console.log(`[PacketLoader] Loading ${type}/${slug}, candidates:`, candidates.length);

    let bestPacket = null;
    let loadedSource = 'missing';

    // 2. Iterate and Fetch (First Match Wins)
    for (const path of candidates) {
        // We only want Fused (Primary) or Entities (Fallback)
        // We skip replicas (.v-1) for speed unless main fails (implicit in order)
        const pack = await fetchCompressedJSON(path);

        if (pack) {
            // Unpack if wrapped (Fused/Entities often wrapped in { entity: ... })
            const ent = pack.entity || pack;

            // Validate minimal integrity (must have ID)
            if (ent && (ent.id || ent.slug)) {
                bestPacket = pack;
                loadedSource = path.includes('fused') ? 'fused' : 'entities-fallback';
                console.log(`[PacketLoader] Locked on source: ${path}`);
                break;
            }
        }
    }

    // 3. Normalize Output for Frontend
    if (!bestPacket) {
        return {
            entity: null,
            html: null,
            mesh: null,
            _meta: { source: 'missing', available: false }
        };
    }

    // Unpack fields (Fused packet has these top-level)
    // Entities packet only has `entity` (and maybe `computed`)
    const finalEntity = bestPacket.entity || bestPacket; // Flexible unwrap
    const finalHtml = bestPacket.html || bestPacket.html_readme || null; // Fused usually has `html`
    const finalMesh = bestPacket.mesh || bestPacket.mesh_profile || null; // Fused usually has `mesh` (if any)

    return {
        entity: finalEntity,
        html: finalHtml,     // Will be null if using Entity Fallback
        mesh: finalMesh,     // Will be null if using Entity Fallback
        _meta: {
            loadedAt: new Date().toISOString(),
            source: loadedSource,
            available: true,
            isFused: loadedSource === 'fused'
        }
    };
}
