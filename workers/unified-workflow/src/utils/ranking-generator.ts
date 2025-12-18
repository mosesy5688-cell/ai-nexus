import { Env } from '../config/types';
import { writeToR2 } from './gzip';

export async function generateRankings(env: Env) {
    console.log('[L8] Generating V6.0 static rankings pages...');

    // V6.0: 5 Primary Categories (Annex A.2.1)
    const categories = [
        'text-generation',
        'knowledge-retrieval',
        'vision-multimedia',
        'automation-workflow',
        'infrastructure-ops'
    ];

    for (const cat of categories) {
        console.log(`[L8] Generating rankings for category: ${cat}`);

        // V6.0: Use primary_category field
        const baseFields = `id, slug, name, author, fni_score, downloads, likes, description, tags, 
                           cover_image_url, has_ollama, has_gguf, primary_category, 
                           category_confidence, size_bucket, size_source`;

        const baseQuery = `SELECT ${baseFields} FROM models 
                          WHERE primary_category = ? 
                          AND fni_score IS NOT NULL`;

        // Count total
        const countRes = await env.DB.prepare(
            `SELECT COUNT(*) as total FROM models WHERE primary_category = ? AND fni_score IS NOT NULL`
        ).bind(cat).first();

        const total = (countRes as any)?.total || 0;
        const totalPages = Math.min(50, Math.ceil(total / 1000)); // Constitution Art 2.4: Max p50

        // Generate Meta
        const meta = {
            category: cat,
            total,
            per_page: 1000,
            pages: totalPages,
            generated_at: new Date().toISOString(),
            version: 'V6.0'
        };
        await writeToR2(env, `cache/rankings/${cat}/meta.json`, meta);

        // Generate Pages (with rank penalty applied)
        for (let p = 1; p <= totalPages; p++) {
            const offset = (p - 1) * 1000;
            const query = `${baseQuery} 
                          ORDER BY (fni_score * CASE WHEN category_confidence = 'low' THEN 0.7 ELSE 1.0 END) DESC 
                          LIMIT 1000 OFFSET ?`;

            const results = await env.DB.prepare(query).bind(cat, offset).all();

            if (results.results && results.results.length > 0) {
                const pageData = {
                    meta: { page: p, total: totalPages, category: cat },
                    models: results.results
                };
                await writeToR2(env, `cache/rankings/${cat}/p${p}.json`, pageData);
            }
        }
        console.log(`[L8] Generated ${totalPages} pages for ${cat} (${total} models)`);
    }
}
