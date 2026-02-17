// V15.1 Unified Entity Cache Reader Core (Art.I-Extended: Frontend D1 = 0)
import { R2_CACHE_URL } from '../config/constants.js';

import { stripPrefix, getTypeFromId } from './mesh-routing-core.js';

// Normalize entity slug for R2 storage path
export function normalizeEntitySlug(id, type = 'model') {
    if (!id) return '';

    // V15.12: Handle array inputs from Astro [...slug] routes
    let slug = Array.isArray(id) ? id.join('/') : id;

    // V16.9.4: Protect date formats (Reports)
    if (type === 'report' && /^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(slug)) {
        return slug.replace(/\//g, '-');
    }

    // V16.9.22: Internal ID Alignment - Use improved stripPrefix to handle all variants (--, :, /)
    const base = stripPrefix(slug);

    // If it was already a valid prefixed R2 string (returned by stripPrefix as raw, but we want the canonical form)
    // Actually, normalizeEntitySlug should return the "path-safe" ID used in the mesh.
    // In our architecture, the mesh IDs often STILL have prefixes to avoid collisions between gh/hf.

    // V16.8.15: If the input HAD a prefix, we might want to preserve the CANONICAL prefix.
    // But usually, normalizeEntitySlug is used for R2 path generation where prefixes are handled by candidates.

    return base.replace(/[:\/]/g, '--');
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

    // V18.2.5 FIX: Always try prefixes regardless of hyphens (google--gemma needs hf-model-- prefix)
    prefixes.forEach(p => {
        const prefixed = lowerSlug.startsWith(p) ? lowerSlug : `${p}${lowerSlug}`;

        // 1. [PRIMARY] Fused Storage (High Fidelity)
        candidates.push(`cache/fused/${prefixed}.json.gz`);
        candidates.push(`cache/fused/${prefixed}.json`);

        // 2. [SECONDARY] Entity Storage (The Anchor)
        candidates.push(`cache/entities/${singular}/${prefixed}.json.gz`);
        candidates.push(`cache/entities/${singular}/${prefixed}.json`);

        // 3. [NEW V21.0] Mesh Profiles (Relations)
        candidates.push(`cache/mesh/profiles/${prefixed}.json.gz`);
        candidates.push(`cache/mesh/profiles/${prefixed}.json`);
    });

    // 4. [FALLBACK] Direct / Flat Paths (No prefix)
    candidates.push(`cache/fused/${lowerSlug}.json.gz`);
    candidates.push(`cache/fused/${lowerSlug}.json`);
    candidates.push(`cache/entities/${singular}/${lowerSlug}.json.gz`);
    candidates.push(`cache/entities/${singular}/${lowerSlug}.json`);
    candidates.push(`cache/mesh/profiles/${lowerSlug}.json.gz`);
    candidates.push(`cache/mesh/profiles/${lowerSlug}.json`);

    // V16.8.31: ArXiv Dotted Fallbacks (R2 reality check)
    if (singular === 'paper' && lowerSlug.includes('.')) {
        const hyphenated = lowerSlug.replace(/\./g, '-');
        candidates.push(`cache/entities/paper/${hyphenated}.json.gz`);
        candidates.push(`cache/entities/paper/${hyphenated}.json`);
    }

    // V16.9.1: Reports Daily Subfolder Alignment
    if (singular === 'report') {
        candidates.push(`cache/reports/daily/${lowerSlug}.json.gz`);
        candidates.push(`cache/reports/daily/${lowerSlug}.json`);
    }

    candidates.push(`cache/${singular}/${lowerSlug}.json.gz`);
    candidates.push(`cache/${singular}/${lowerSlug}.json`);
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
                    const isGzipURL = path.endsWith('.gz');
                    const buffer = await res.arrayBuffer();
                    const uint8 = new Uint8Array(buffer);
                    const isActuallyGzip = uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b;

                    let data;
                    if (isActuallyGzip) {
                        try {
                            const ds = new DecompressionStream('gzip');
                            const decompressedRes = new Response(new Response(buffer).body?.pipeThrough(ds));
                            data = await decompressedRes.json();
                        } catch (e) {
                            console.warn(`[Reader] Decompression failed for ${cdnUrl}, trying text.`);
                            try { data = JSON.parse(new TextDecoder().decode(buffer)); } catch (err) { data = null; }
                        }
                    } else {
                        try {
                            data = JSON.parse(new TextDecoder().decode(buffer));
                        } catch (e) {
                            if (isGzipURL) console.warn(`[Reader] Failed to parse ${cdnUrl} as JSON.`);
                            continue;
                        }
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
    if (import.meta.env.DEV || process.env.NODE_ENV === 'test') {
        try {
            const fs = await import('node:fs');
            const zlib = await import('node:zlib');
            const r2CandidatePaths = getR2PathCandidates(type, normalized);
            const pluralType = type.endsWith('s') ? type : `${type}s`;
            const searchPaths = [
                ...r2CandidatePaths.map(p => `g:/ai-nexus/data/${p}`),
                ...r2CandidatePaths.map(p => `g:/ai-nexus/data/cache/entities/${singular}/${p.split('/').pop()}`),
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
                        const list = Array.isArray(data) ? data : (data.entities || []);
                        const found = list.find(m => {
                            const mId = m.id || m.slug || '';
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
                        return { ...data, entity: data.entity || data, _cache_source: 'local-fs-shim' };
                    }
                }
            }
        } catch (e) {
            console.warn(`[Reader Shim] Error:`, e.message);
        }
    }
    return null;
}


