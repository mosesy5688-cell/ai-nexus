import { Env } from '../config/types';
import { writeToR2 } from './gzip';
import { generateSitemaps } from './sitemap-generator';
// Helper for L8 Precomputation (Trending, Graph, Sitemap, etc.)

export async function generateTrendingAndLeaderboard(env: Env) {
    console.log('[L8] Starting cache precompute...');
    // V5.2.1: Filter for actual models only (not datasets/papers/repos)
    const modelFilter = `(id LIKE 'huggingface%' OR id LIKE 'ollama%')`;
    // Trending models (top 100 by FNI)
    const trending = await env.DB.prepare(`
        SELECT id, slug, name, author, fni_score, downloads, likes,
                cover_image_url, tags, has_ollama, has_gguf
        FROM models 
        WHERE fni_score IS NOT NULL AND ${modelFilter}
        ORDER BY fni_score DESC 
        LIMIT 100
    `).all();

    if (trending.results && trending.results.length > 0) {
        await writeToR2(env, 'cache/trending.json', {
            generated_at: new Date().toISOString(),
            version: 'V4.7',
            count: trending.results.length,
            models: trending.results
        });
        console.log(`[L8] Trending cache: ${trending.results.length} models`);
    }

    // Leaderboard (top 50 with benchmarks)
    const leaderboard = await env.DB.prepare(`
        SELECT m.id, m.slug, m.name, m.author, m.fni_score,
                m.deploy_score, m.architecture_family, m.has_ollama
        FROM models m
        WHERE m.fni_score IS NOT NULL AND ${modelFilter}
        ORDER BY m.fni_score DESC
        LIMIT 50
    `).all();

    if (leaderboard.results && leaderboard.results.length > 0) {
        await writeToR2(env, 'cache/leaderboard.json', {
            generated_at: new Date().toISOString(),
            version: 'V4.7',
            count: leaderboard.results.length,
            models: leaderboard.results
        });
        console.log(`[L8] Leaderboard cache: ${leaderboard.results.length} models`);
    }
}

export async function generateNeuralGraph(env: Env) {
    console.log('[L8] Generating neural graph...');

    const graphNodes = await env.DB.prepare(`
        SELECT id, slug, name, author, architecture_family, 
                deploy_score, fni_score, has_ollama
        FROM models 
        WHERE fni_score IS NOT NULL
        ORDER BY fni_score DESC
        LIMIT 200
    `).all();

    const graphLinks = await env.DB.prepare(`
        SELECT source_id, target_id, link_type, confidence
        FROM entity_links
        LIMIT 1000
    `).all();

    const graphVersion = new Date().toISOString().split('T')[0];
    const neuralGraph = {
        version: graphVersion,
        generated_at: new Date().toISOString(),
        schema: 'V4.8.2',
        nodes: (graphNodes.results || []).map((m: any) => ({
            id: m.id,
            slug: m.slug,
            name: m.name,
            author: m.author,
            arch: m.architecture_family || 'unknown',
            deployScore: m.deploy_score || 0,
            fni: m.fni_score || 0,
            local: m.has_ollama === 1
        })),
        links: (graphLinks.results || []).map((l: any) => ({
            source: l.source_id,
            target: l.target_id,
            type: l.link_type,
            weight: l.confidence
        }))
    };

    await writeToR2(env, 'cache/neural_graph.json', neuralGraph);
    console.log(`[L8] Neural graph: ${neuralGraph.nodes.length} nodes, ${neuralGraph.links.length} links`);
}

export async function generateCategoryStats(env: Env) {
    console.log('[L8] Generating V6.0.1 category stats...');

    // V6.0.1: 5 Primary Categories (Constitution Annex A.2.1 - FROZEN)
    const primaryCategories = [
        { id: 'text-generation', label: 'Text Generation & Content Creation', icon: '💬', color: '#6366f1' },
        { id: 'knowledge-retrieval', label: 'Knowledge Retrieval & Data Analysis', icon: '🔍', color: '#10b981' },
        { id: 'vision-multimedia', label: 'Vision & Multimedia Processing', icon: '🎨', color: '#f59e0b' },
        { id: 'automation-workflow', label: 'Automation & Workflow Integration', icon: '⚡', color: '#8b5cf6' },
        { id: 'infrastructure-ops', label: 'Infrastructure & Optimization', icon: '🔧', color: '#64748b' }
    ];

    // Count classified models per primary_category
    const categoryPromises = primaryCategories.map(async (cat) => {
        const result = await env.DB.prepare(`
            SELECT 
                COUNT(*) as cnt, 
                AVG(fni_score) as avg_fni, 
                MAX(fni_score) as top_fni,
                SUM(CASE WHEN last_updated > datetime('now', '-7 days') THEN 1 ELSE 0 END) as trending
            FROM models 
            WHERE primary_category = ? AND category_status = 'classified'
        `).bind(cat.id).first();

        return {
            category: cat.id,
            label: cat.label,
            icon: cat.icon,
            color: cat.color,
            count: (result as any)?.cnt || 0,
            trending: (result as any)?.trending || 0,
            avgFni: (result as any)?.avg_fni ? Math.round((result as any).avg_fni * 10) / 10 : null,
            topFni: (result as any)?.top_fni ? Math.round((result as any).top_fni * 10) / 10 : null
        };
    });

    const categoryResults = await Promise.all(categoryPromises);
    const classifiedCount = categoryResults.reduce((sum, c) => sum + c.count, 0);

    // V6.0.1: Count pending_classification models
    const pendingResult = await env.DB.prepare(`
        SELECT COUNT(*) as cnt FROM models 
        WHERE category_status = 'pending_classification' OR primary_category IS NULL
    `).first();
    const pendingCount = (pendingResult as any)?.cnt || 0;

    // V6.0.1: Total model count
    const totalResult = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM models`).first();
    const totalModels = (totalResult as any)?.cnt || 0;

    const categoryData = {
        generated_at: new Date().toISOString(),
        version: 'V6.0.1',
        categories: categoryResults,
        classified_count: classifiedCount,
        total_models: totalModels,
        total_categories: 5,
        // V6.0.1 Transparency: Show pending classification stats
        pending_classification: {
            count: pendingCount,
            reason: 'missing_pipeline_tag',
            note: 'High-confidence classification only. Semantic inference in V6.1'
        }
    };

    await writeToR2(env, 'cache/category_stats.json', categoryData);
    console.log(`[L8] V6.0.1 Category stats: ${classifiedCount} classified, ${pendingCount} pending, ${totalModels} total`);
}

export async function generateEntityLinksAndBenchmarks(env: Env) {
    console.log('[L8] Generating benchmarks... ');
    const benchmarks = await env.DB.prepare(`
        SELECT 
            id as umid, slug, name, author,
            fni_score, pwc_benchmarks
        FROM models 
        WHERE fni_score IS NOT NULL
        ORDER BY fni_score DESC
        LIMIT 500
    `).all();

    const benchmarkData = {
        generated_at: new Date().toISOString(),
        version: 'V4.8.2',
        data: (benchmarks.results || []).map((m: any) => {
            let parsed: any = {};
            try { if (m.pwc_benchmarks) parsed = JSON.parse(m.pwc_benchmarks); } catch { }
            return {
                umid: m.umid,
                slug: m.slug,
                name: m.name,
                author: m.author,
                fni_score: m.fni_score,
                mmlu: parsed.mmlu || null,
                avg_score: parsed.avg_score || m.fni_score,
                quality_flag: 'ok'
            };
        })
    };

    await writeToR2(env, 'cache/benchmarks.json', benchmarkData);
}

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

