// src/pages/api/model/[slug].js
export const prerender = false;

import { getModelBySlug } from '../../../utils/db';

export async function GET({ params, locals }) {
    try {
        const { slug } = params;

        if (!slug) {
            return new Response(JSON.stringify({ error: 'No slug provided' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 获取原始数据
        const model = await getModelBySlug(slug, locals);

        if (!model || typeof model !== 'object' || !model.id || !model.name) {
            return new Response(JSON.stringify({ error: 'Model not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // [防御性检查] 处理 description (防止它是对象)
        if (typeof model.description !== 'string') {
            model.description = model.description ? String(model.description) : "";
        }

        // 解析 related_ids
        let relatedIds = [];
        if (model.related_ids) {
            try {
                const parsed = JSON.parse(model.related_ids);
                if (Array.isArray(parsed)) {
                    relatedIds = parsed;
                }
            } catch (e) {
                console.warn("Failed to parse related_ids JSON:", e);
            }
        }

        // 🔥 SMART FALLBACK: If no related_ids, get top models in same category
        let relatedModels = [];
        if (relatedIds.length === 0 && model.pipeline_tag) {
            try {
                const db = locals?.runtime?.env?.DB;
                if (db) {
                    const stmt = db.prepare(`
                        SELECT id, name, author, likes, downloads, cover_image_url, description 
                        FROM models 
                        WHERE pipeline_tag = ? AND id != ?
                        ORDER BY downloads DESC 
                        LIMIT 6
                    `);
                    const { results } = await stmt.bind(model.pipeline_tag, model.id).all();
                    relatedModels = results || [];
                }
            } catch (fallbackErr) {
                console.warn("Smart fallback failed:", fallbackErr);
            }
        }

        return new Response(JSON.stringify({
            model,
            relatedIds,
            relatedModels
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
