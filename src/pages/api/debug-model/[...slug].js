// src/pages/api/debug-model/[...slug].js
// Temporary debug endpoint to diagnose Model Not Found issue
export const prerender = false;

import { getModelBySlug } from '../../../utils/db';

export async function GET({ params, locals }) {
    try {
        const { slug } = params;

        // Get the raw slug value and type
        const slugType = typeof slug;
        const slugArray = Array.isArray(slug);
        const slugValue = slug;

        // Normalize slug if it's an array
        const normalizedSlug = Array.isArray(slug) ? slug.join('/') : slug;

        // Try to get model
        const rawModel = await getModelBySlug(normalizedSlug, locals);

        return new Response(JSON.stringify({
            debug: {
                slug_original: slugValue,
                slug_type: slugType,
                slug_is_array: slugArray,
                slug_normalized: normalizedSlug,
                rawModel_exists: !!rawModel,
                rawModel_id: rawModel?.id || null,
                rawModel_name: rawModel?.name || null,
                rawModel_umid: rawModel?.umid || null
            }
        }, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({
            error: e.message,
            stack: e.stack
        }, null, 2), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
