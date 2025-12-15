export const prerender = false; // Enable SSR for this endpoint

/**
 * V4.9.1 REPAIR: R2-First Search Implementation
 * Constitution: Art.I-Extended - Frontend D1 = 0
 * Logic: Fetch entity_index.json -> In-Memory Filter -> Return
 */

/**
 * Derive entity type (helper)
 */
function deriveEntityType(id) {
    if (!id) return 'model';
    if (id.startsWith('hf-model--')) return 'model';
    if (id.startsWith('hf-dataset--')) return 'dataset';
    if (id.startsWith('benchmark--')) return 'benchmark';
    if (id.startsWith('arxiv--')) return 'paper';
    if (id.startsWith('agent--')) return 'agent';
    return 'model';
}

export async function GET({ request, locals }) {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    const tag = url.searchParams.get('tag');
    const sort = url.searchParams.get('sort') || 'likes';
    const limit = parseInt(url.searchParams.get('limit') || '12', 10);
    const entityType = url.searchParams.get('entity_type') || 'model';

    // Additional filters
    const minLikes = parseInt(url.searchParams.get('min_likes') || '0', 10);
    const hasBenchmarks = url.searchParams.get('has_benchmarks') === 'true';
    const sources = url.searchParams.getAll('source').map(s => s.toLowerCase());

    const r2 = locals.runtime?.env?.R2_ASSETS;
    const kv = locals.runtime?.env?.KV_CACHE;

    if (!r2) {
        return new Response(JSON.stringify({ error: 'Search Service Unavailable (R2)' }), { status: 503 });
    }

    try {
        // 1. Fetch Index (Try KV first for speed, then R2)
        let indexData = [];
        let indexSource = 'r2';

        if (kv) {
            const cachedIndex = await kv.get('meta:entity_index', { type: 'json' });
            if (cachedIndex) {
                indexData = cachedIndex;
                indexSource = 'kv';
            }
        }

        if (indexData.length === 0) {
            const r2Obj = await r2.get('cache/meta/entity_index.json');
            if (r2Obj) {
                indexData = await r2Obj.json();
                // Async populate KV for next time
                if (kv) ctx.waitUntil(kv.put('meta:entity_index', JSON.stringify(indexData), { expirationTtl: 300 }));
            }
        }

        if (indexData.length === 0) {
            // Fallback: Return empty if index not ready
            return new Response(JSON.stringify({ results: [], meta: { status: 'indexing_pending' } }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 2. In-Memory Filtering
        let results = indexData.filter(item => {
            // A. Entity Type
            if (item.type !== entityType) return false;

            // B. Full Text Search (Simple substring match for Repair Phase)
            if (query) {
                const searchTarget = `${item.name} ${item.description || ''} ${item.author} ${item.slug}`.toLowerCase();
                if (!searchTarget.includes(query)) return false;
            }

            // C. Tag Filter
            if (tag) {
                const itemTags = Array.isArray(item.tags) ? item.tags : [];
                if (!itemTags.some(t => t.toLowerCase().includes(tag.toLowerCase()))) return false;
            }

            // D. Min Likes
            if (minLikes > 0 && (item.stats?.likes || 0) < minLikes) return false;

            // E. Benchmarks
            if (hasBenchmarks && !(item.stats?.fni > 0)) return false; // Approx proxy

            return true;
        });

        // 3. Sorting
        results.sort((a, b) => {
            if (sort === 'likes') return (b.stats?.likes || 0) - (a.stats?.likes || 0);
            if (sort === 'downloads') return (b.stats?.downloads || 0) - (a.stats?.downloads || 0);
            if (sort === 'last_updated') return new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime();
            if (sort === 'relevance') return 0; // Already filtered
            return 0; // Default
        });

        // 4. Pagination
        const total = results.length;
        const sliced = results.slice(0, limit);

        // 5. Enrich (Map back to Search Card format)
        // The index already has minimal fields. We format them for frontend.
        const responseData = sliced.map(item => ({
            id: item.id,
            slug: item.slug,
            name: item.name,
            author: item.author,
            description: item.description, // Should be in index
            tags: item.tags,
            likes: item.stats?.likes || 0,
            downloads: item.stats?.downloads || 0,
            fni_score: item.stats?.fni,
            entity_type: item.type,
            cover_image_url: null, // Index might not have it, use placeholder logic in frontend
            source: 'huggingface' // Default
        }));

        return new Response(JSON.stringify({
            results: responseData,
            meta: {
                version: 'V4.9.1',
                source: indexSource,
                total
            }
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60',
                'X-Search-Source': indexSource
            }
        });

    } catch (e) {
        console.error('[Search] Error:', e);
        return new Response(JSON.stringify({ error: 'Search Failed' }), { status: 500 });
    }
}
