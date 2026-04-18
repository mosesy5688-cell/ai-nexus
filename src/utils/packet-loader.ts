import { R2_CACHE_URL } from '../config/constants.js';
import { normalizeEntitySlug } from './entity-cache-reader-core.js';
import { fetchBundleRange } from './vfs-fetcher.js';
import { resolveVfsMetadata } from './vfs-metadata-provider.js';
import { env } from 'cloudflare:workers';

/**
 * V26.5 C1: VFS-Only Entity Loader
 * TIER 0 (meta-NN.db SQLite) is authoritative.
 * Bundle hydration via fetchBundleRange for README/mesh/relations.
 */
export async function loadEntityStreams(type: string, slug: string, locals: any = null) {
    const normalized = normalizeEntitySlug(slug, type).toLowerCase();
    let dataSource = '404';

    // TIER 0: VFS Primary — meta-NN.db SQLite query (authoritative)
    let entityPack: any = null;
    try {
        const vfsMatch = await resolveVfsMetadata(type, normalized, locals);
        if (vfsMatch?.data) {
            entityPack = vfsMatch.data;
            dataSource = vfsMatch.source || 'vfs-primary';
        }
    } catch (e: any) {
        console.warn(`[Loader] VFS query failed for ${normalized}:`, e.message);
    }

    if (!entityPack) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, dataSource: '404', source: '404' } };
    }

    // Validate identity
    if (!entityPack.id && !entityPack.name && !entityPack.slug) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, source: 'invalid-packet' } };
    }
    if (!entityPack.id) entityPack.id = normalized.includes('--') ? normalized.replace(/--/g, '/') : normalized;

    // Bundle hydration: fetch README + mesh from fused-shard binary
    let html: string | null = null;
    let mesh: any[] = entityPack.relations ? JSON.parse(entityPack.relations) : [];

    if (entityPack.bundle_key && entityPack.bundle_size > 0) {
        try {
            const bundle = await fetchBundleRange(entityPack.bundle_key, entityPack.bundle_offset, entityPack.bundle_size);
            if (bundle) {
                html = bundle.readme || bundle.html_readme || null;
                mesh = bundle.mesh_profile?.relations || bundle.relations || mesh;
            }
        } catch (e: any) {
            console.warn(`[Loader] Bundle hydration failed for ${entityPack.id}:`, e.message);
        }
    }

    return {
        entity: entityPack,
        html,
        mesh,
        _meta: {
            available: true,
            dataSource,
            source: 'vfs-primary',
            streams: { entity: true, html: !!html, mesh: mesh.length > 0 },
            paths: { entity: dataSource, fused: html ? 'loaded' : 'missing', mesh: mesh.length > 0 ? 'loaded' : 'missing' }
        }
    };
}
