// V26.0: Astro 6 migration — use cloudflare:workers instead of locals.runtime.env
import { env } from 'cloudflare:workers';

export const prerender = false;

export async function GET({ params }) {
    const path = params.path;
    const r2 = env?.R2_ASSETS;

    if (!r2) {
        return new Response(JSON.stringify({ error: 'R2 not available' }), { status: 500 });
    }

    if (!path) {
        return new Response(JSON.stringify({ error: 'Path required' }), { status: 400 });
    }

    try {
        const object = await r2.get(`cache/${path}`);

        if (object === null) {
            return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Cache-Control', 'public, max-age=60');

        return new Response(object.body, {
            headers
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
