// V15.1 Unified Entity Cache Reader Core (Art.I-Extended: Frontend D1 = 0)
import { R2_CACHE_URL } from '../config/constants.js';

import { stripPrefix, getTypeFromId } from './mesh-routing-core.js';

// Normalize entity slug for R2 storage path
export function normalizeEntitySlug(id, type = 'model') {
    if (!id) return '';

    // V15.12: Handle array inputs from Astro [...slug] routes
    let slug = Array.isArray(id) ? id.join('/') : id;

    // V16.9.22: Strip any legacy or current prefixes before normalizing for slug/path
    const base = stripPrefix(slug).replace(/[:\/]/g, '--');
    return base;
}

// V16.8.5: SPEC-ID-V2.1 Alignment - "Robust Tri-Stream Discovery"
export function getR2PathCandidates(type, normalizedSlug) {
    const typeMap = {
        'datasets': 'dataset', 'models': 'model', 'agents': 'agent',
        'spaces': 'space', 'tools': 'tool', 'papers': 'paper'
    };
    const singular = typeMap[type] || (type.endsWith('s') ? type.slice(0, -1) : type);
    const lowerSlug = normalizedSlug.toLowerCase();

    // V18.2.1: Unified Prefix Map for all storage tiers
    const prefixMap = {
        'model': ['hf-model--', 'gh-model--', 'civitai--', 'ollama--', 'replicate--', 'kaggle--', 'hf--', 'gh--'],
        'dataset': ['hf-dataset--', 'kaggle-dataset--', 'dataset--', 'hf--'],
        'paper': ['arxiv-paper--', 'arxiv--', 'paper--', 'hf-paper--'],
        'space': ['hf-space--', 'space--'],
        'agent': ['gh-agent--', 'hf-agent--', 'agent--'],
        'tool': ['gh-tool--', 'hf-tool--', 'tool--', 'github-tool--']
    };
    const prefixes = prefixMap[singular] || [];

    const candidates = [];

    // 1. [PRIMARY] Fused Storage (High Fidelity)
    // We've confirmed hf-model--meta-llama--meta-llama-3-8b.json.gz exists here.
    prefixes.forEach(p => {
        const fullSlug = lowerSlug.includes('--') ? lowerSlug : `${p}${lowerSlug}`;
        candidates.push(`cache/fused/${fullSlug}.json.gz`);
        candidates.push(`cache/fused/${fullSlug}.json`);

        // Check if the input lowerSlug ALREADY has the prefix
        if (lowerSlug.startsWith(p)) {
            candidates.push(`cache/fused/${lowerSlug}.json.gz`);
            candidates.push(`cache/fused/${lowerSlug}.json`);
        } else {
            const prefixed = `${p}${lowerSlug}`;
            candidates.push(`cache/fused/${prefixed}.json.gz`);
            candidates.push(`cache/fused/${prefixed}.json`);
        }
    });

    // 2. [SECONDARY] Entity Storage (The Anchor)
    // confirmed: hf-dataset--... , gh-agent--...
    prefixes.forEach(p => {
        const fullSlug = lowerSlug.startsWith(p) ? lowerSlug : `${p}${lowerSlug}`;
        candidates.push(`cache/entities/${singular}/${fullSlug}.json.gz`);
        candidates.push(`cache/entities/${singular}/${fullSlug}.json`);
    });

    // 3. [FALLBACK] Direct / Flat Paths
    candidates.push(`cache/entities/${singular}/${lowerSlug}.json.gz`);
    candidates.push(`cache/entities/${singular}/${lowerSlug}.json`);
    candidates.push(`cache/entities/${lowerSlug}.json.gz`);
    candidates.push(`cache/entities/${lowerSlug}.json`);

    return [...new Set(candidates)];
}


import { hydrateEntity, augmentEntity } from './entity-hydrator.js';
export { hydrateEntity, augmentEntity };




/**
 * Base fetcher for R2 assets with local FS shim for development
 */
export async function fetchEntityFromR2(type, slug, locals) {
    const normalized = normalizeEntitySlug(slug, type);

    // 1. Try R2 Cache (Production/Preview SSR)
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (r2) {
        const paths = getR2PathCandidates(type, normalized);
        console.log(`[R2Reader] Checking ${paths.length} paths for ${type}/${normalized}`);
        for (const path of paths) {
            try {
                const file = await r2.get(path);
                if (file) {
                    // V18.2: Handle Gzip decompression in Worker environment
                    let data;
                    if (path.endsWith('.gz')) {
                        const ds = new DecompressionStream('gzip');
                        const decompressedStream = file.body.pipeThrough(ds);
                        const response = new Response(decompressedStream);
                        data = await response.json();
                    } else {
                        data = await file.json();
                    }

                    return {
                        entity: data.entity || data,
                        computed: data.computed || {},
                        seo: data.seo || {},
                        _cache_path: path,
                        _cache_source: 'r2-cache'
                    };
                }
            } catch (e) {
                console.warn(`[R2Reader] Error reading ${path}:`, e.message);
            }
        }
    }

    // 2. Browser/Static CDN Fetch (No R2 runtime)
    if (!r2 || typeof window !== 'undefined') {
        const paths = getR2PathCandidates(type, normalized);
        for (const path of paths) {
            try {
                // V16.8 FIX: Force relative path on client-side to avoid CORS with CDN
                // SSR (no window) still uses R2_CACHE_URL if needed, but R2 runtime (r2 binding) is preferred.
                const baseUrl = typeof window !== 'undefined' ? '' : R2_CACHE_URL;
                const cdnUrl = `${baseUrl}/${path}`;

                const res = await fetch(cdnUrl);
                if (res.ok) {
                    let data;
                    const isGzip = path.endsWith('.gz');
                    const isAlreadyDecompressed = res.headers.get('Content-Encoding') === 'gzip' || res.headers.get('content-encoding') === 'gzip';

                    if (isGzip && !isAlreadyDecompressed) {
                        try {
                            const ds = new DecompressionStream('gzip');
                            const decompressedStream = res.body.pipeThrough(ds);
                            const decompressedRes = new Response(decompressedStream);
                            data = await decompressedRes.json();
                        } catch (e) {
                            // If manual decompression fails, try direct JSON (might have been transparently decompressed after all)
                            data = await res.json();
                        }
                    } else {
                        data = await res.json();
                    }

                    return {
                        entity: data.entity || data,
                        computed: data.computed || {},
                        seo: data.seo || {},
                        _cache_path: path,
                        _cache_source: 'cdn-static'
                    };
                }
            } catch (e) {
                // Ignore and try next path
            }
        }
    }

    // V15.2: Global CDN Fallback (entities.json) REMOVED per memory safety (Art 5.1)
    // 368MB entities.json exceeds 128MB Worker memory limit.
    // Fallback logic should rely on sharded rankings if individual entity fetch fails.

    // 2. Dev Shim: Local Filesystem (Art 2.4 / B14 Compatibility)
    if (import.meta.env.DEV || process.env.NODE_ENV === 'test') {

        try {
            const fs = await import('node:fs');
            const zlib = await import('node:zlib');
            const r2CandidatePaths = getR2PathCandidates(type, normalized);
            const pluralType = type.endsWith('s') ? type : `${type}s`;

            // Add legacy data directory paths
            const searchPaths = [
                ...r2CandidatePaths.map(p => `g:/ai-nexus/data/${p}`),
                ...r2CandidatePaths.map(p => `g:/ai-nexus/data/cache/entities/${type}/${p.split('/').pop()}`),
                `g:/ai-nexus/data/merged.json`,
                `g:/ai-nexus/data/${pluralType}.json`
            ];

            for (const localPath of searchPaths) {
                if (fs.existsSync(localPath)) {
                    let raw = fs.readFileSync(localPath);
                    if (localPath.endsWith('.gz') || (raw[0] === 0x1f && raw[1] === 0x8b)) {
                        raw = zlib.gunzipSync(raw);
                    }
                    const data = JSON.parse(raw.toString('utf-8'));

                    if (localPath.endsWith('merged.json') || localPath.match(/data\/[a-z]+s\.json$/)) {
                        // Scan list for the entity
                        const list = Array.isArray(data) ? data : (data.entities || []);
                        const found = list.find(m => {
                            const mId = m.id || m.slug || '';
                            // Try matching regular normalized slug or prefixed version
                            return r2CandidatePaths.some(p => {
                                const fileName = p.split('/').pop().replace('.json', '');
                                return (mId.toLowerCase() === fileName) || (normalizeEntitySlug(mId, type) === normalized);
                            });
                        });

                        if (found) {
                            return {
                                entity: found,
                                computed: { fni: found.fni_score || found.fni || 0 },
                                _cache_source: 'local-fs-shim'
                            };
                        }
                    } else {
                        return {
                            ...data,
                            entity: data.entity || data,
                            _cache_source: 'local-fs-shim'
                        };
                    }
                }
            }
        } catch (e) {
            console.warn(`[Reader Shim] Error:`, e.message);
        }
    }

    return null;
}


