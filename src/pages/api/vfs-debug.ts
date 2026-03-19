import type { APIRoute } from 'astro';
// V26.0: Astro 6 migration — use cloudflare:workers instead of locals.runtime.env
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ url }) => {
    const r2 = env?.R2_ASSETS;
    if (!r2) return new Response('R2 binding missing', { status: 500 });

    const path = url.searchParams.get('path') || 'cache/fused/arxiv-paper--2011.05081.json.gz';

    try {
        const file = await r2.get(path);
        if (!file) return new Response(`File not found: ${path}`, { status: 404 });

        let content = '';
        if (path.endsWith('.gz')) {
            const ds = new DecompressionStream('gzip');
            const decompressedStream = file.body.pipeThrough(ds);
            const res = new Response(decompressedStream);
            content = await res.text();
        } else {
            content = await file.text();
        }

        return new Response(JSON.stringify({
            exists: true,
            size: file.size,
            path: path,
            content: content.slice(0, 5000)
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500 });
    }
}
