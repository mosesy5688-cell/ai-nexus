import { normalizeEntitySlug } from './entity-cache-reader-core.js';
import { fetchBundleRange } from './vfs-fetcher.js';
import { resolveVfsMetadata, isVfsFound } from './vfs-metadata-provider.js';
import { initShardDecrypt, decryptShardRange } from '../lib/shard-decrypt.js';
import { env } from 'cloudflare:workers';

/**
 * Cold-tier readme/mesh fetch from .bin fused-shard via range read.
 * Used by loadEntityStreams (frontend) and /api/v1/entity?include=body.
 * Memory discipline: drop the compressed buffer before parsing JSON so CF
 * Worker GC can reclaim before the 50ms CPU budget runs out on hot calls.
 */
export async function fetchBundleReadme(
    bundle_key: string, bundle_offset: number, bundle_size: number
): Promise<{ readme: string | null; mesh: any[] }> {
    if (!bundle_key || !bundle_size || bundle_size <= 0) return { readme: null, mesh: [] };
    const r2 = env?.R2_ASSETS;
    if (r2) {
        const obj = await r2.get(bundle_key, { range: { offset: bundle_offset, length: bundle_size } });
        if (!obj) return { readme: null, mesh: [] };
        let raw: Uint8Array | null = new Uint8Array(await (obj as any).arrayBuffer());
        if (bundle_key.endsWith('.bin') && (env as any)?.AES_CRYPTO_KEY) {
            await initShardDecrypt((env as any).AES_CRYPTO_KEY);
            raw = new Uint8Array(await decryptShardRange(bundle_key.split('/').pop() || '', raw.buffer, bundle_offset));
        }
        let decoded: string;
        if (raw.length >= 4 && raw[0] === 0x28 && raw[1] === 0xB5 && raw[2] === 0x2F && raw[3] === 0xFD) {
            const { decompress } = await import('fzstd');
            decoded = new TextDecoder().decode(decompress(raw));
        } else if (raw.length >= 2 && raw[0] === 0x1F && raw[1] === 0x8B) {
            const pako = await import('pako');
            decoded = pako.ungzip(raw, { to: 'string' });
        } else {
            decoded = new TextDecoder().decode(raw);
        }
        raw = null;
        const bundle = JSON.parse(decoded);
        return {
            readme: bundle.readme || bundle.html_readme || null,
            mesh: bundle.mesh_profile?.relations || bundle.relations || [],
        };
    }
    const bundle = await fetchBundleRange(bundle_key, bundle_offset, bundle_size);
    if (!bundle) return { readme: null, mesh: [] };
    return {
        readme: bundle.readme || bundle.html_readme || null,
        mesh: bundle.mesh_profile?.relations || bundle.relations || [],
    };
}

/**
 * V26.5 C1: VFS-Only Entity Loader
 * TIER 0 (meta-NN.db SQLite) is authoritative.
 * Bundle hydration via fetchBundleReadme for README/mesh/relations.
 */
export async function loadEntityStreams(type: string, slug: string, locals: any = null) {
    const normalized = normalizeEntitySlug(slug, type).toLowerCase();
    let dataSource = '404';

    // TIER 0: VFS Primary — meta-NN.db SQLite query (authoritative).
    // V27.97: the resolver now returns a 3-way result. A transient timeout/error
    // MUST be surfaced as `_meta.transient` so the page renders a retryable
    // soft response (no cache, no 404) instead of caching a false 404 for a real
    // entity. A genuine miss is `available:false` + `transient:false`.
    let entityPack: any = null;
    let transient = false;
    try {
        const vfsMatch = await resolveVfsMetadata(type, normalized, locals);
        if (isVfsFound(vfsMatch)) {
            entityPack = vfsMatch.data;
            dataSource = vfsMatch.source || 'vfs-primary';
        } else if ('transient' in vfsMatch) {
            transient = true;
        }
    } catch (e: any) {
        // Defensive: an unexpected throw is inconclusive, never a confirmed miss.
        transient = true;
        console.warn(`[Loader] VFS query failed for ${normalized}:`, e.message);
    }

    if (!entityPack) {
        return {
            entity: null, html: null, mesh: null,
            _meta: { available: false, transient, dataSource: transient ? 'transient' : '404', source: transient ? 'transient' : '404' }
        };
    }

    // Validate identity
    if (!entityPack.id && !entityPack.name && !entityPack.slug) {
        return { entity: null, html: null, mesh: null, _meta: { available: false, source: 'invalid-packet' } };
    }
    if (!entityPack.id) entityPack.id = normalized.includes('--') ? normalized.replace(/--/g, '/') : normalized;

    let html: string | null = null;
    let mesh: any[] = entityPack.relations ? JSON.parse(entityPack.relations) : [];

    if (entityPack.bundle_key && entityPack.bundle_size > 0) {
        try {
            const bundle = await fetchBundleReadme(entityPack.bundle_key, entityPack.bundle_offset, entityPack.bundle_size);
            html = bundle.readme;
            if (bundle.mesh.length > 0) mesh = bundle.mesh;
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
