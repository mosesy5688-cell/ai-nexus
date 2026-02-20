import { R2_CACHE_URL } from '../config/constants.js';
import { getR2PathCandidates, normalizeEntitySlug, fetchEntityFromR2 } from './entity-cache-reader-core.js';
import { fetchBundleRange } from './vfs-fetcher.js';
import { promoteEngine2Fields } from './dual-engine-merger.js';

const CDN_SECONDARY = 'https://ai-nexus-assets.pages.dev/cache';

/**
 * Resilient fetching with timeout and secondary fallback
 */
async function fetchWithResilience(url: string, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (response.ok) return response;
        throw new Error(`HTTP ${response.status}`);
    } catch (e: any) {
        clearTimeout(id);
        // V19.4.6: Fix double /cache path regression. R2_CACHE_URL points to origin, CDN_SECONDARY includes /cache.
        // If url is https://cdn.free2aitools.com/cache/..., replacement must avoid /cache/cache/
        const secondaryUrl = url.replace('https://cdn.free2aitools.com/cache', CDN_SECONDARY);
        console.warn(`[Resilience] Primary fetch failed for ${url}, trying secondary: ${secondaryUrl}`);
        return fetch(secondaryUrl, { signal: AbortSignal.timeout(timeout) });
    }
}

// V19.4: Clean Gzip-First Fetcher
export async function fetchCompressedJSON(path: string): Promise<any | null> {
    const baseUrl = path.startsWith('http') ? '' : R2_CACHE_URL;
    const fullUrl = path.startsWith('http') ? path : `${baseUrl}/${path}`;

    // V19.4 Optimization: In V19.3+, everything is Gzipped. 
    // We only probe the .gz variant to reduce 404 count and latency.
    const targetUrl = fullUrl.endsWith('.gz') ? fullUrl : `${fullUrl}.gz`;

    try {
        const res = await fetchWithResilience(targetUrl);
        if (!res.ok) {
            // Fallback to uncompressed ONLY for specific legacy paths if needed
            if (fullUrl.includes('/fused/')) return null;
            const legacyRes = await fetchWithResilience(fullUrl);
            if (!legacyRes.ok) return null;
            return legacyRes.json();
        }

        const buffer = await res.arrayBuffer();
        const uint8 = new Uint8Array(buffer);

        // V19.4.9: Robust Magic Byte Detection (0x1f 0x8b)
        // Detects "Fake Gzip" (JSON content with .gz extension) and handles raw JSON safely
        const isTrueGzip = uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b;

        if (isTrueGzip) {
            try {
                const ds = new DecompressionStream('gzip');
                const decompressedRes = new Response(new Response(buffer).body?.pipeThrough(ds));
                return decompressedRes.json();
            } catch (decompError: any) {
                console.warn(`[Loader] Gzip decompression failed for ${targetUrl}, attempting raw JSON parse:`, decompError.message);
                return JSON.parse(new TextDecoder().decode(buffer));
            }
        } else {
            // V19.4.9: Support for plain JSON in .gz container
            try {
                return JSON.parse(new TextDecoder().decode(buffer));
            } catch (jsonError: any) {
                console.error(`[Loader] Failed to parse target ${targetUrl} as JSON:`, jsonError.message);
                return null;
            }
        }
    } catch (e: any) {
        console.error(`[Loader] Fetch error for ${targetUrl}:`, e.message);
        return null;
    }
}

/**
 * V19.4: High-Density Parallel Loader
 * Optimized with "Race-to-Hit" strategy (Promise.any)
 */
export async function loadEntityStreams(type: string, slug: string, locals: any = null) {
    const normalized = normalizeEntitySlug(slug, type).toLowerCase();
    const candidates = getR2PathCandidates(type, normalized);

    // Step A: Parallel Candidate Racing (P0 Optimization)
    // Instead of sequential probes, we blast all primary candidates and take the first success.
    const primaryCandidates = candidates.filter(c => c.includes('/entities/') || c.includes('/fused/'));

    // V19.4: Resilient Parallel Race
    const raceCandidate = async (path: string) => {
        const data = await fetchCompressedJSON(path);
        if (!data) throw new Error('Miss');
        return { data, path };
    };

    let entityResult;
    try {
        // Rapid discovery of the anchor metadata
        entityResult = await Promise.any(primaryCandidates.map(p => raceCandidate(p)));
    } catch (e) {
        // Fallback for non-standard types (Reports, etc)
        const otherCandidates = candidates.filter(c => !primaryCandidates.includes(c));
        try {
            entityResult = await Promise.any(otherCandidates.map(p => raceCandidate(p)));
        } catch (err) {
            // V21.5: Final Sequential Recovery (The "Old Engine" Fallback)
            // If parallel racing fails, we fall back to the sequential reader which is more robust
            // in some edge cases and handles local filesystem shims in DEV.
            console.warn(`[Loader] Parallel race failed for ${normalized}, trying sequential recovery...`);
            const sequentialResult = await fetchEntityFromR2(type, normalized, locals);

            if (!sequentialResult) {
                return { entity: null, html: null, mesh: null, _meta: { available: false, source: '404' } };
            }

            entityResult = {
                data: sequentialResult.entity || sequentialResult,
                path: sequentialResult._cache_path || 'sequential'
            };
        }
    }

    let entityPack = entityResult.data.entity || entityResult.data;
    let entitySourcePath = entityResult.path;

    if (!entityPack) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, source: '404' } };
    }

    // V19.4.15: ID Persistence Logic
    // If the source data (Registry/VFS) lacks an ID, we MUST inject the normalized ID
    // to prevent downstream "ID Unknown" UI failures and broken routing.
    if (!entityPack.id) {
        entityPack.id = normalized;
        console.log(`[Hydration] Injected normalized ID: ${normalized}`);
    }

    // --- ANCHOR ESTABLISHED ---
    // V19.4: Transition to VFS Binary Shards for Heavy Assets (HTML/Mesh)
    const rawId = entityPack.bundle_key ? entityPack.id : (entityPack.id || entityPack.slug || slug);
    const fullId = (rawId.includes('--') || rawId.includes(':')) ? rawId : normalizeEntitySlug(rawId, type);

    let html: string | null = entityPack.html_readme || null;
    let mesh: any[] = entityPack.relations || [];

    // VFS Ignition: If bundle metadata exists, fetch from shards (High Performance Stream)
    if (entityPack.bundle_key && entityPack.bundle_size > 0) {
        const bundle = await fetchBundleRange(entityPack.bundle_key, entityPack.bundle_offset, entityPack.bundle_size);
        if (bundle) {
            html = bundle.readme || bundle.html_readme || html;
            mesh = bundle.mesh_profile?.relations || mesh;
            console.log(`[VFS-Ignition] Hydrated heavy assets from ${entityPack.bundle_key}`);
        }
    }

    // --- Dual-Engine Integration: VFS + R2 Fallback Recovery ---
    // V19.4.5: We MUST merge metadata from both streams if fields are missing or TRUNCATED.
    // Engine 1 (Fast VFS) often truncates READMEs to snippets to save index space.
    const isHtmlTruncated = !html || html.length < 1500;

    if (isHtmlTruncated || mesh.length === 0) {
        const secondaryCandidates = getR2PathCandidates(type, normalized);
        const fusedCandidates = secondaryCandidates.filter(c => c.includes('/fused/'));
        const meshCandidates = secondaryCandidates.filter(c => c.includes('/mesh/profiles/'));

        // Legacy Fallback Reader: Extracting missing content from R2
        console.warn(`[TELEMETRY] vfs_fallback_event: ${fullId} (Missing/Truncated: ${isHtmlTruncated ? 'HTML' : ''} ${mesh.length === 0 ? 'Mesh' : ''})`);

        // 1. Recover Monolithic Fused JSON (Contains BOTH Rich Text and Relations)
        let fusedSuccessfullyFetched = false;

        for (const fPath of fusedCandidates) {
            const fusedPack = await fetchCompressedJSON(fPath);
            if (fusedPack) {
                fusedSuccessfullyFetched = true;
                const innerEntity = fusedPack.entity || fusedPack;

                // Recover HTML
                if (isHtmlTruncated) {
                    const recoveredHtml = innerEntity.html_readme || fusedPack.html_readme || innerEntity.body_content || innerEntity.readme || null;
                    if (recoveredHtml && recoveredHtml.length > (html?.length || 0)) {
                        html = recoveredHtml;
                    }
                }

                // Recover Mesh from Fused
                if (mesh.length === 0) {
                    const recoveredMesh = innerEntity.relations || fusedPack.relations || innerEntity.mesh_profile?.relations || [];
                    if (recoveredMesh.length > 0) {
                        mesh = recoveredMesh;
                        entityPack.relations = recoveredMesh;
                    }
                }

                // Field Promotion (V19.5): Robustly merge Engine 2 metadata
                promoteEngine2Fields(entityPack, innerEntity, fusedPack);

                break;
            }
        }

        // 2. Dedicated Mesh Recovery (If Fused failed to provide relations)
        if (mesh.length === 0) {
            for (const mPath of meshCandidates) {
                const meshPack = await fetchCompressedJSON(mPath);
                if (meshPack) {
                    const recoveredMesh = meshPack.relations || meshPack.nodes || meshPack.links || [];
                    if (recoveredMesh.length > 0) {
                        mesh = recoveredMesh;
                        entityPack.relations = recoveredMesh; // Persistent hydration
                        break;
                    }
                }
            }
        }
    }

    const finalHtml = html;

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
                fused: finalHtml ? 'loaded' : 'missing',
                mesh: mesh.length > 0 ? 'loaded' : 'missing'
            }
        }
    };
}
