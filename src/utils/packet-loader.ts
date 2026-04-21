import { R2_CACHE_URL } from '../config/constants.js';
import { normalizeEntitySlug } from './entity-cache-reader-core.js';
import { fetchBundleRange } from './vfs-fetcher.js';
import { resolveVfsMetadata } from './vfs-metadata-provider.js';
import { initShardDecrypt, decryptShardRange } from '../lib/shard-decrypt.js';
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

    // Bundle hydration: fetch README + mesh from fused-shard binary via R2 direct
    let html: string | null = null;
    let mesh: any[] = entityPack.relations ? JSON.parse(entityPack.relations) : [];

    if (entityPack.bundle_key && entityPack.bundle_size > 0) {
        try {
            const r2 = env?.R2_ASSETS;
            if (r2) {
                console.log(`[Loader] R2 direct: key=${entityPack.bundle_key} offset=${entityPack.bundle_offset} size=${entityPack.bundle_size}`);
                const obj = await r2.get(entityPack.bundle_key, {
                    range: { offset: entityPack.bundle_offset, length: entityPack.bundle_size }
                });
                if (obj) {
                    let raw = new Uint8Array(await (obj as any).arrayBuffer());
                    console.log(`[Loader] R2 got ${raw.length} bytes, first4: ${raw[0]?.toString(16)} ${raw[1]?.toString(16)} ${raw[2]?.toString(16)} ${raw[3]?.toString(16)}`);
                    if (entityPack.bundle_key.endsWith('.bin') && (env as any)?.AES_CRYPTO_KEY) {
                        await initShardDecrypt((env as any).AES_CRYPTO_KEY);
                        raw = new Uint8Array(await decryptShardRange(entityPack.bundle_key.split('/').pop() || '', raw.buffer, entityPack.bundle_offset));
                        console.log(`[Loader] Decrypted ${raw.length} bytes, first4: ${raw[0]?.toString(16)} ${raw[1]?.toString(16)} ${raw[2]?.toString(16)} ${raw[3]?.toString(16)}`);
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
                    const bundle = JSON.parse(decoded);
                    html = bundle.readme || bundle.html_readme || null;
                    mesh = bundle.mesh_profile?.relations || bundle.relations || mesh;
                    console.log(`[Loader] Bundle OK: readme=${!!html} (${(html||'').length} chars), mesh=${mesh.length} relations`);
                } else {
                    console.warn(`[Loader] R2 returned null for ${entityPack.bundle_key}`);
                }
            } else {
                const bundle = await fetchBundleRange(entityPack.bundle_key, entityPack.bundle_offset, entityPack.bundle_size);
                if (bundle) {
                    html = bundle.readme || bundle.html_readme || null;
                    mesh = bundle.mesh_profile?.relations || bundle.relations || mesh;
                }
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
