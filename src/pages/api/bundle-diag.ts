import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { initShardDecrypt, decryptShardRange } from '../../lib/shard-decrypt.js';
import { resolveVfsMetadata } from '../../utils/vfs-metadata-provider.js';
import { normalizeEntitySlug } from '../../utils/entity-cache-reader-core.js';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
    const slug = url.searchParams.get('slug') || 'meta-llama--llama-3.1-8b';
    const type = url.searchParams.get('type') || 'model';
    const steps: any[] = [];

    try {
        const normalized = normalizeEntitySlug(slug, type).toLowerCase();
        let dbSlug = normalized;
        if (type === 'paper' && !normalized.includes('--')) dbSlug = `unknown--${normalized}`;
        steps.push({ step: 'normalize', slug: normalized, dbSlug });

        const vfs = await resolveVfsMetadata(type, slug);
        if (!vfs?.data) {
            steps.push({ step: 'vfs', status: 'NOT_FOUND' });
            return json(steps);
        }
        const e = vfs.data;
        steps.push({ step: 'vfs', status: 'OK', source: vfs.source, bundle_key: e.bundle_key, bundle_offset: e.bundle_offset, bundle_size: e.bundle_size, has_id: !!e.id, has_slug: !!e.slug });

        if (!e.bundle_key || !e.bundle_size) {
            steps.push({ step: 'bundle', status: 'NO_BUNDLE_KEY' });
            return json(steps);
        }

        const r2 = env?.R2_ASSETS;
        if (!r2) { steps.push({ step: 'r2', status: 'NO_R2_BINDING' }); return json(steps); }

        const obj = await r2.get(e.bundle_key, { range: { offset: e.bundle_offset, length: e.bundle_size } });
        if (!obj) { steps.push({ step: 'r2_get', status: 'NULL' }); return json(steps); }

        let raw = new Uint8Array(await (obj as any).arrayBuffer());
        steps.push({ step: 'r2_get', status: 'OK', bytes: raw.length, first4: `${hex(raw[0])} ${hex(raw[1])} ${hex(raw[2])} ${hex(raw[3])}` });

        const hasKey = !!(env as any)?.AES_CRYPTO_KEY;
        steps.push({ step: 'aes_key', hasKey });

        if (e.bundle_key.endsWith('.bin') && hasKey) {
            await initShardDecrypt((env as any).AES_CRYPTO_KEY);
            raw = new Uint8Array(await decryptShardRange(e.bundle_key.split('/').pop() || '', raw.buffer, e.bundle_offset));
            steps.push({ step: 'decrypt', bytes: raw.length, first4: `${hex(raw[0])} ${hex(raw[1])} ${hex(raw[2])} ${hex(raw[3])}` });
        }

        let decoded: string;
        const isZstd = raw.length >= 4 && raw[0] === 0x28 && raw[1] === 0xB5 && raw[2] === 0x2F && raw[3] === 0xFD;
        const isGzip = raw.length >= 2 && raw[0] === 0x1F && raw[1] === 0x8B;
        const isJson = raw.length > 0 && raw[0] === 0x7B;

        if (isZstd) {
            const { decompress } = await import('fzstd');
            decoded = new TextDecoder().decode(decompress(raw));
            steps.push({ step: 'decompress', method: 'zstd', chars: decoded.length });
        } else if (isGzip) {
            const pako = await import('pako');
            decoded = pako.ungzip(raw, { to: 'string' });
            steps.push({ step: 'decompress', method: 'gzip', chars: decoded.length });
        } else if (isJson) {
            decoded = new TextDecoder().decode(raw);
            steps.push({ step: 'decompress', method: 'raw_json', chars: decoded.length });
        } else {
            steps.push({ step: 'decompress', method: 'UNKNOWN_FORMAT', first4: `${hex(raw[0])} ${hex(raw[1])} ${hex(raw[2])} ${hex(raw[3])}` });
            return json(steps);
        }

        const bundle = JSON.parse(decoded);
        const keys = Object.keys(bundle);
        steps.push({ step: 'parse', status: 'OK', keys, readme_len: (bundle.readme || '').length, html_readme_len: (bundle.html_readme || '').length, relations_count: (bundle.mesh_profile?.relations || bundle.relations || []).length });

    } catch (e: any) {
        steps.push({ step: 'ERROR', message: e.message, stack: e.stack?.split('\n').slice(0, 3) });
    }
    return json(steps);
};

function hex(b: number) { return b !== undefined ? b.toString(16).padStart(2, '0') : '??'; }
function json(data: any) {
    return new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
