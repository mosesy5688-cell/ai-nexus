export const prerender = false;

import { getModelBySlug } from '../../../utils/db.js';

export async function GET({ request, params, locals }) {
    const { id } = params; // This is the catch-all slug, e.g., "meta-llama--llama-3"
    if (!id) {
        return new Response('Missing Image ID', { status: 400 });
    }

    const R2 = locals.runtime.env.R2_ASSETS;
    const objectKey = `covers/${id}.jpg`;

    try {
        // 1. Check R2 Cache
        const cached = await R2.get(objectKey);
        if (cached) {
            const headers = new Headers();
            cached.writeHttpMetadata(headers);
            headers.set('etag', cached.httpEtag);
            headers.set('Cache-Control', 'public, max-age=604800, immutable'); // 1 week cache
            return new Response(cached.body, { headers });
        }

        // 2. Fetch Source URL from DB
        const model = await getModelBySlug(locals.runtime.env.DB, id.replace('.jpg', ''));

        // Fallback: If not found by slug, try ID parsing
        let sourceUrl = model?.cover_image_url;

        // Last Resort: If no DB cover, return 404
        if (!sourceUrl || sourceUrl.includes('placeholder')) {
            return new Response('Image not found', { status: 404 });
        }

        // 3. Fetch from Source
        const sourceRes = await fetch(sourceUrl);
        if (!sourceRes.ok) {
            return new Response('Upstream image error', { status: 502 });
        }

        // 4. Validate Content Type
        const contentType = sourceRes.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
            return new Response('Invalid upstream image', { status: 502 });
        }

        // 5. Stream Save to R2 (Read-Through)
        // We clone the response: one stream to R2, one to user
        const imageBuffer = await sourceRes.arrayBuffer();

        // Limit size? (Optional: Reject > 5MB)
        if (imageBuffer.byteLength > 5 * 1024 * 1024) {
            // Too big to cache blindly, maybe redirect or serve directly without caching?
            // For now, cache it.
        }

        await R2.put(objectKey, imageBuffer, {
            httpMetadata: { contentType: contentType }, // Preserve original type or force 'image/jpeg'
        });

        // 6. Serve
        return new Response(imageBuffer, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=604800, immutable'
            }
        });

    } catch (e) {
        console.error(`Image CDN Error (${id}):`, e);
        return new Response('Image Service Error', { status: 500 });
    }
}
