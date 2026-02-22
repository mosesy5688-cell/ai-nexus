import { R2_CACHE_URL } from '../config/constants.js';
import { getR2PathCandidates, normalizeEntitySlug, fetchEntityFromR2 } from './entity-cache-reader-core.js';
import { fetchBundleRange } from './vfs-fetcher.js';
import { promoteEngine2Fields } from './dual-engine-merger.js';
import { fetchCompressedJSON } from './resilient-fetch.js';

/**
 * V19.4: High-Density Parallel Loader
 * Optimized with "Race-to-Hit" strategy (Promise.any)
 */
export async function loadEntityStreams(type: string, slug: string, locals: any = null) {
    const normalized = normalizeEntitySlug(slug, type).toLowerCase();

    let entityResult;

    // V21.13: Server-First Recovery Strategy (Internal R2 Priority)
    if (locals?.runtime?.env?.R2_ASSETS && typeof window === 'undefined') {
        const sequentialResult = await fetchEntityFromR2(type, normalized, locals);
        if (sequentialResult) {
            entityResult = {
                data: sequentialResult.entity || sequentialResult,
                path: sequentialResult._cache_path || 'r2-binding'
            };
        }
    }

    if (!entityResult) {
        const candidates = getR2PathCandidates(type, normalized);
        const primaryCandidates = candidates.filter(c => c.includes('/entities/') || c.includes('/fused/'));

        const raceCandidate = async (path: string) => {
            const data = await fetchCompressedJSON(path);
            if (!data) throw new Error('Miss');
            return { data, path };
        };

        try {
            entityResult = await Promise.any(primaryCandidates.map(p => raceCandidate(p)));
        } catch (e) {
            const otherCandidates = candidates.filter(c => !primaryCandidates.includes(c));
            try {
                entityResult = await Promise.any(otherCandidates.map(p => raceCandidate(p)));
            } catch (err) {
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
    // However, some entities legitimately have short READMEs (like datasets), so we MUST ALSO 
    // reliably trigger fallback if the relation mesh is empty, preserving the Knowledge Graph.
    const isHtmlTruncated = !html || html.length < 1500;
    const isMeshMissing = !mesh || mesh.length === 0;

    // V21.7 Guard: Only skip Engine 2 fetch if we have BOTH a decent HTML size AND relation links.
    if (isHtmlTruncated || isMeshMissing) {
        const secondaryCandidates = getR2PathCandidates(type, normalized);
        const fusedCandidates = secondaryCandidates.filter(c => c.includes('/fused/'));
        const meshCandidates = secondaryCandidates.filter(c => c.includes('/mesh/profiles/'));

        // Legacy Fallback Reader: Extracting missing content from R2
        console.warn(`[TELEMETRY] vfs_fallback_event: ${fullId} (Missing/Truncated HTML: ${isHtmlTruncated}, Missing Mesh: ${isMeshMissing})`);

        // 1. Recover Monolithic Fused JSON (Contains BOTH Rich Text and Relations)
        let fusedSuccessfullyFetched = false;

        for (const fPath of fusedCandidates) {
            const fusedPack = await fetchCompressedJSON(fPath);
            if (fusedPack) {
                fusedSuccessfullyFetched = true;
                const innerEntity = fusedPack.entity || fusedPack;

                // Recover HTML (V21.15.3: Longest Wins)
                if (isHtmlTruncated) {
                    const recoveredHtml = innerEntity.html_readme || fusedPack.html_readme || innerEntity.body_content || innerEntity.readme || null;
                    const currentLen = html?.length || 0;
                    const recoveredLen = recoveredHtml?.length || 0;

                    if (recoveredHtml && recoveredLen > currentLen) {
                        html = recoveredHtml;
                    }
                }

                // Recover Mesh from Fused (Priority over VFS snippets)
                if (mesh.length === 0 || (fusedPack.relations?.length > mesh.length)) {
                    const recoveredMesh = innerEntity.relations || fusedPack.relations || innerEntity.mesh_profile?.relations || [];
                    if (recoveredMesh.length > mesh.length) {
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
