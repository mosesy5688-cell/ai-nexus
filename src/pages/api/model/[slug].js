// src/pages/api/model/[slug].js
/**
 * Model API V4.5 (S-Grade)
 * Constitution V4.3.2 Compliant - UMID Resolver Integration
 */
export const prerender = false;

import { resolveToModel } from '../../../utils/umid-resolver';
import { safeParseJSON } from '../../../utils/model-detail-builder';

export async function GET({ params, locals }) {
    try {
        const { slug } = params;

        if (!slug) {
            return new Response(JSON.stringify({ error: 'No slug provided' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // V4.5: Use UMID Resolver (12-rule normalization + KV cache)
        const { model, resolution } = await resolveToModel(slug, locals);

        if (!model || typeof model !== 'object' || !model.id || !model.name) {
            return new Response(JSON.stringify({
                error: 'Model not found',
                resolution // Include resolution info for debugging
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // [Defensive Check] Handle description
        if (typeof model.description !== 'string') {
            model.description = model.description ? String(model.description) : "";
        }

        // Parse related_ids safely
        const relatedIds = safeParseJSON(model.related_ids, []);

        // Fetch related models
        let relatedModels = [];
        // V14.2: D1 query REMOVED per Zero-Cost Constitution
        // Related models feature temporarily disabled until R2-based solution is implemented
        // TODO: Implement related models using R2 cache/relations.json

        return new Response(JSON.stringify({
            model,
            relatedIds,
            relatedModels,
            resolution // V4.5: Include resolution info
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
            }
        });

    } catch (e) {
        console.error('API Error:', e);
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
