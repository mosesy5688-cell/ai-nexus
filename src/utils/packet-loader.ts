import { R2_CACHE_URL } from '../config/constants.js';
import { getR2PathCandidates, normalizeEntitySlug, fetchEntityFromR2 } from './entity-cache-reader-core.js';
import { fetchBundleRange } from './vfs-fetcher.js';
import { promoteEngine2Fields } from './dual-engine-merger.js';
import { fetchCompressedJSON } from './resilient-fetch.js';
import { fetchCatalogData } from './catalog-fetcher.js';
import { resolveVfsMetadata } from './vfs-metadata-provider.js';

/**
 * V22.8: High-Density VFS Parallel Loader
 * Strictly prioritizes VFS (SQLite) over legacy JSON streams.
 */
export async function loadEntityStreams(type: string, slug: string, locals: any = null) {
    const normalized = normalizeEntitySlug(slug, type).toLowerCase();
    const isSimulatingRemote = !!(typeof process !== 'undefined' && process.env.SIMULATE_PRODUCTION);

    let entityResult;

    // TIER 0: VFS Primary Discovery (V22.8 Mandate)
    try {
        const vfsMatch = await resolveVfsMetadata(type, normalized, locals);
        if (vfsMatch?.data) {
            entityResult = {
                data: vfsMatch.data,
                path: vfsMatch.source,
                isVfs: true
            };
        }
    } catch (e: any) {
        console.warn(`[Loader] VFS Discovery skipped for ${normalized}:`, e.message);
    }

    // TIER 1: Server-First Recovery Strategy (Internal R2 Priority)
    if (!entityResult && locals?.runtime?.env?.R2_ASSETS && typeof window === 'undefined') {
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

    // V21.15.10: Catalog Fallback Discovery (Engine 1 Fallback)
    // If the entity profile is missing from R2, try to find a stub in the ranking indices.
    if (!entityResult) {
        const { items: catalogItems } = await fetchCatalogData(type, locals);
        const stub = catalogItems.find(item =>
            normalizeEntitySlug(item.id || item.slug, type) === normalized ||
            (item.id || '').toLowerCase() === normalized
        );

        if (stub) {
            entityResult = {
                data: stub,
                path: 'catalog-index'
            };
            console.log(`[Loader] Resolved ${normalized} via Catalog Index Fallback`);
        }
    }

    if (!entityResult) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, source: '404' } };
    }

    let entityPack = entityResult.data?.entity || entityResult.data;
    let entitySourcePath = entityResult.path;

    if (!entityPack) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, source: '404' } };
    }

    // V22.8: Regulated ID Persistence
    // If the source data lacks a canonical ID, we MUST inject a regulated Short-ID
    // structure (hierarchical) to maintain routing and VFS search parity.
    if (!entityPack.id) {
        entityPack.id = normalized.includes('--') ? normalized.replace(/--/g, '/') : normalized;
        console.log(`[Hydration] Injected regulated ID: ${entityPack.id}`);
    }

    // 3. Validation & Recovery Guard
    // A valid entity must have an identity. Content (README) is now hydrated 
    // asynchronously via VFS if missing from the initial packet.
    const hasIdentity = !!(entityPack.id || entityPack.name || entityPack.canonical_name || entityPack.slug || entityPack.title || entityPack.abstract);
    if (!hasIdentity) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, source: 'invalid-packet' } };
    }

    // --- ANCHOR ESTABLISHED ---
    // V19.4: Transition to VFS Binary Shards for Heavy Assets (HTML/Mesh)
    const rawId = entityPack.bundle_key ? entityPack.id : (entityPack.id || entityPack.slug || slug);
    const fullId = (rawId.includes('--') || rawId.includes(':')) ? rawId : normalizeEntitySlug(rawId, type);

    let html: string | null = entityPack.html_readme || null;
    let mesh: any[] = entityPack.relations || [];

    // VFS Ignition: If bundle metadata exists, fetch from shards (High Performance Stream)
    if (entityPack.bundle_key && entityPack.bundle_size > 0) {
        try {
            const bundle = await fetchBundleRange(entityPack.bundle_key, entityPack.bundle_offset, entityPack.bundle_size);
            if (bundle) {
                // V22.10: Metadata from Shard is the ONLY authority for README/Mesh if present.
                html = bundle.readme || bundle.html_readme || null;
                mesh = bundle.mesh_profile?.relations || bundle.relations || mesh;
                console.log(`[VFS-Ignition] Hydrated high-fidelity assets for ${fullId}`);
            }
        } catch (e: any) {
            console.warn(`[VFS-Ignition-FAIL] Shard recovery failed for ${fullId}:`, e.message);
        }
    }

    // --- Dual-Engine Integration: VFS + R2 Fallback Recovery ---
    // V19.4.5: We MUST merge metadata from both streams if fields are missing or TRUNCATED.
    // Engine 1 (Fast VFS) often truncates READMEs to snippets to save index space.
    // However, some entities legitimately have short READMEs (like datasets), so we MUST ALSO 
    // reliably trigger fallback if the relation mesh is empty, preserving the Knowledge Graph.
    // V21.15.8: High-Fidelity Priority - Models/Papers ALWAYS attempt recovery to ensure metadata completeness.
    const isPriorityEntity = type === 'model' || type === 'paper';
    const isHtmlTruncated = !html || html.length < 8000;
    const isMeshMissing = !mesh || mesh.length === 0;

    if (isPriorityEntity || isHtmlTruncated || isMeshMissing) {
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
