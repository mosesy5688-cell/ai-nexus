import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals, url }) => {
    const r2 = locals.runtime?.env?.R2_ASSETS;
    if (!r2) return new Response('R2 binding missing', { status: 500 });

    const path = url.searchParams.get('path') || 'cache/fused/arxiv-paper--2011.05081.json.gz';

    try {
        const file = await r2.get(path);
        if (!file) return new Response(`File not found: ${path}`, { status: 404 });

        return new Response(JSON.stringify({
            exists: true,
            size: file.size,
            etag: file.etag,
            httpMetadata: file.httpMetadata
        }), { status: 200 });
    } catch (e: any) {
        return new Response(`Error: ${e.message}`, { status: 500 });
    }
}
