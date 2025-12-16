
import { Env } from '../config/types';
import { writeToR2 } from './gzip';

// Helper for L8 Precomputation (Trending, Graph, etc.)

export async function generateTrendingAndLeaderboard(env: Env) {
    console.log('[L8] Starting cache precompute...');

    // Trending models (top 100 by FNI)
    const trending = await env.DB.prepare(`
        SELECT id, slug, name, author, fni_score, downloads, likes,
                cover_image_url, tags, has_ollama, has_gguf
        FROM models 
        WHERE fni_score IS NOT NULL
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
        WHERE m.fni_score IS NOT NULL
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
    console.log('[L8] Generating category stats...');

    const categoryStats = await env.DB.prepare(`
        SELECT 
            pipeline_tag as category,
            COUNT(*) as model_count,
            AVG(fni_score) as avg_fni,
            MAX(fni_score) as top_fni
        FROM models 
        WHERE pipeline_tag IS NOT NULL AND pipeline_tag != ''
        GROUP BY pipeline_tag
        ORDER BY model_count DESC
        LIMIT 50
    `).all();

    const categoryData = {
        generated_at: new Date().toISOString(),
        version: 'V4.8.2',
        pipeline_tags: (categoryStats.results || []).map((c: any) => ({
            category: c.category,
            count: c.model_count,
            avgFni: c.avg_fni ? Math.round(c.avg_fni * 10) / 10 : null,
            topFni: c.top_fni ? Math.round(c.top_fni * 10) / 10 : null
        })),
        total_categories: (categoryStats.results || []).length
    };

    await writeToR2(env, 'cache/category_stats.json', categoryData);
    console.log(`[L8] Category stats: ${categoryData.total_categories} categories`);
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
    console.log('[L8] Generating static rankings pages...');

    // Categories to generate rankings for
    const categories = ['text-generation', 'image-generation', 'audio-generation', 'video-generation', 'agent'];
    // Also 'all' category
    categories.push('all');

    for (const cat of categories) {
        console.log(`[L8] Generating rankings for category: ${cat}`);
        const isAll = cat === 'all';
        const baseQuery = isAll
            ? `SELECT id, slug, name, author, fni_score, downloads, likes, description, tags, 
                      cover_image_url, has_ollama, has_gguf 
               FROM models WHERE fni_score IS NOT NULL`
            : `SELECT id, slug, name, author, fni_score, downloads, likes, description, tags, 
                      cover_image_url, has_ollama, has_gguf 
               FROM models WHERE fni_score IS NOT NULL AND (pipeline_tag = '${cat}' OR tags LIKE '%${cat}%')`;

        // Count total
        const countQuery = isAll
            ? `SELECT COUNT(*) as total FROM models WHERE fni_score IS NOT NULL`
            : `SELECT COUNT(*) as total FROM models WHERE fni_score IS NOT NULL AND (pipeline_tag = '${cat}' OR tags LIKE '%${cat}%')`;

        const countRes = await env.DB.prepare(countQuery).first();
        const total = (countRes as any).total || 0;
        const totalPages = Math.min(50, Math.ceil(total / 1000));

        // Generate Meta
        const meta = {
            category: cat,
            total,
            per_page: 1000,
            pages: totalPages,
            generated_at: new Date().toISOString()
        };
        await writeToR2(env, `cache/rankings/${cat}/meta.json`, meta);

        // Generate Pages
        for (let p = 1; p <= totalPages; p++) {
            const offset = (p - 1) * 1000;
            const query = `${baseQuery} ORDER BY fni_score DESC LIMIT 1000 OFFSET ${offset}`;
            const results = await env.DB.prepare(query).all();

            if (results.results) {
                await writeToR2(env, `cache/rankings/${cat}/p${p}.json`, results.results);
            }
        }
        console.log(`[L8] Generated ${totalPages} pages for ${cat}`);
    }
}
