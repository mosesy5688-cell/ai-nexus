import { R2_CACHE_URL } from '../config/constants.js';
import { getR2PathCandidates, normalizeEntitySlug } from './entity-cache-reader-core.js';

const CDN_SECONDARY = 'https://ai-nexus-assets.pages.dev/cache';

/**
 * Resilient fetching with timeout and secondary fallback
 */
async function fetchWithResilience(url: string, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url.replace('cdn.free2aitools.com', 'cdn.free2aitools.com'), { signal: controller.signal });
        clearTimeout(id);
        if (response.ok) return response;
        throw new Error(`HTTP ${response.status}`);
    } catch (e: any) {
        clearTimeout(id);
        const secondaryUrl = url.replace('https://cdn.free2aitools.com', CDN_SECONDARY);
        console.warn(`[Resilience] Primary fetch failed for ${url}, trying secondary: ${secondaryUrl}`);
        return fetch(secondaryUrl, { signal: AbortSignal.timeout(timeout) });
    }
}

// Universal Gzip Fetcher (Robust Buffer Strategy)
export async function fetchCompressedJSON(path: string): Promise<any | null> {
    const fullUrl = path.startsWith('http') ? path : `${R2_CACHE_URL}/${path}`;
    const candidates = fullUrl.endsWith('.gz') ? [fullUrl] : [`${fullUrl}.gz`, fullUrl];

    for (const url of candidates) {
        try {
            const res = await fetchWithResilience(url);
            if (!res.ok) continue;

            // V16.9.4: Resilient Decompression - Handle "Fake .gz" (uncompressed text in .gz file)
            const isGzipURL = url.endsWith('.gz');
            const buffer = await res.arrayBuffer();
            const uint8 = new Uint8Array(buffer);
            const isActuallyGzip = uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b;

            if (isActuallyGzip) {
                try {
                    const ds = new DecompressionStream('gzip');
                    const decompressedRes = new Response(new Response(buffer).body?.pipeThrough(ds));
                    const data = await decompressedRes.json();
                    if (data) return data;
                } catch (e: any) {
                    console.warn(`[Loader] Decompression failed for ${url}, trying text fallback.`);
                    try {
                        return JSON.parse(new TextDecoder().decode(buffer));
                    } catch (err) { return null; }
                }
            } else {
                // Not Gzip or already decompressed by CDN edge
                try {
                    const text = new TextDecoder().decode(buffer);
                    return JSON.parse(text);
                } catch (e: any) {
                    if (isGzipURL) console.warn(`[Loader] Failed to parse .gz file ${url} as JSON/Gzip.`);
                    return null;
                }
            }
        } catch (e: any) {
            console.error(`[Loader] Fetch error for ${url}:`, e.message);
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
        // V16.8.15 FIX: Ensure we unwrap { entity: ... } if present
        entityPack = entityResult.data.entity || entityResult.data;
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

    // A.3 [NEW BUGFIX R5] Fallback to ALL candidates for non-primary types (e.g. Reports)
    if (!entityPack) {
        const otherCandidates = candidates.filter(c => !c.includes('/entities/') && !c.includes('/fused/'));
        const otherResult = await findFirst(otherCandidates);
        if (otherResult) {
            entityPack = otherResult.data.entity || otherResult.data;
            entitySourcePath = otherResult.path;
        }
    }

    if (!entityPack) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, source: '404' } };
    }

    // --- ANCHOR ESTABLISHED ---
    // 4. Secondary Stream Discovery (Fused & Mesh) - V16.9.0 Prefix-Aware Pathing
    const rawId = entityPack.id || entityPack.slug || slug;

    // V21.0 CRITICAL: Avoid stripping prefixes for R2 path generation. 
    // R2 paths for fused and mesh profiles MUST use the Full ID (prefixed).
    const fullId = (rawId.includes('--') || rawId.includes(':')) ? rawId : normalizeEntitySlug(rawId, type);

    // Use getR2PathCandidates to get prefix-aware paths for Fused
    const secondaryCandidates = getR2PathCandidates(type, fullId);
    const fusedPath = secondaryCandidates.find(c => c.includes('/fused/')) || `cache/fused/${fullId}.json.gz`;

    const meshCandidates = secondaryCandidates.filter(c => c.includes('/mesh/profiles/'));

    // Attempt to fetch Fused Pack (README/HTML) - SECONDARY PRIORITY (Entity Anchor already has data)
    let fusedPack = await fetchCompressedJSON(fusedPath);
    if (!fusedPack) {
        console.warn(`[Loader] Fused stream MISS at ${fusedPath}`);
        if (!fusedPath.endsWith('.gz')) {
            fusedPack = await fetchCompressedJSON(`${fusedPath}.gz`);
        }
    }

    // --- DATA FUSION (V16.8.8) ---
    // Merge fused metadata into entity metadata (Fidelity Restoration)
    if (fusedPack) {
        // V16.8.15 FIX: Use protective destructuring to avoid overwriting valid fields with undefined
        const { html_readme, name: fusedName, description: fusedDesc, ...fusedMeta } = fusedPack;

        // Aliases for HTML content (Normalize Stream B)
        const html = html_readme || fusedPack.body || fusedPack.content_html || fusedPack.readme_html || entityPack.html_readme || null;

        // Perform Shallow Merge (Favouring Fused for technical metrics, but protecting Identity)
        Object.assign(entityPack, {
            ...fusedMeta,
            html_readme: html,
            // Guard: Never let fusedPack overwrite a valid name with something missing
            name: entityPack.name || fusedName || entityPack.title || fusedPack.title,
            // Guard: Never let a tiny summary overwrite a real README
            description: entityPack.description?.length > 500 ? entityPack.description : (fusedDesc || entityPack.description)
        });
    }

    // Attempt to fetch Mesh Pack (Relations)
    let meshPack = null;
    for (const mPath of meshCandidates) {
        meshPack = await fetchCompressedJSON(mPath);
        if (meshPack) break;
    }

    if (!meshPack) {
        console.warn(`[Loader] Mesh stream MISS for ID: ${fullId}. Tried ${meshCandidates.length} paths.`);
    }

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
                mesh: meshPack ? 'loaded' : 'missing'
            }
        }
    };
}
