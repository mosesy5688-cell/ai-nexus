import { Env } from '../config/types';
import { writeToR2 } from './gzip';

/**
 * V6.3: Generate trending caches for all entity types
 * Extracted from precompute-helpers.ts for CES compliance
 */
export async function generateTrendingAndLeaderboard(env: Env) {
    console.log('[L8] Starting cache precompute...');
    // V5.2.1: Filter for actual models only (not datasets/papers/repos)
    const modelFilter = `type='model' AND (id LIKE 'huggingface%' OR id LIKE 'ollama%')`;
    // Trending models (top 100 by FNI)
    // V6.4: Added technical specs fields for P2 TechnicalSpecs component
    const trending = await env.DB.prepare(`
        SELECT id, slug, name, author, fni_score, downloads, likes,
                cover_image_url, tags, has_ollama, has_gguf,
                last_updated, pwc_benchmarks, pipeline_tag,
                params_billions, context_length, architecture,
                hidden_size, num_layers
        FROM entities 
        WHERE fni_score IS NOT NULL AND ${modelFilter}
        ORDER BY fni_score DESC 
        LIMIT 100
    `).all();

    if (trending.results && trending.results.length > 0) {
        await writeToR2(env, 'cache/trending.json', {
            generated_at: new Date().toISOString(),
            version: 'V6.3',
            count: trending.results.length,
            models: trending.results
        });
        console.log(`[L8] Trending cache: ${trending.results.length} models`);
    }

    // Leaderboard (top 50 with benchmarks)
    const leaderboard = await env.DB.prepare(`
        SELECT m.id, m.slug, m.name, m.author, m.fni_score,
                m.deploy_score, m.architecture_family, m.has_ollama
        FROM entities m
        WHERE m.fni_score IS NOT NULL AND ${modelFilter}
        ORDER BY m.fni_score DESC
        LIMIT 50
    `).all();

    if (leaderboard.results && leaderboard.results.length > 0) {
        await writeToR2(env, 'cache/leaderboard.json', {
            generated_at: new Date().toISOString(),
            version: 'V6.3',
            count: leaderboard.results.length,
            models: leaderboard.results
        });
        console.log(`[L8] Leaderboard cache: ${leaderboard.results.length} models`);
    }

    // V6.3: Generate trending spaces cache for Explore entity filter
    await generateTrendingSpaces(env);

    // V6.3: Generate trending datasets cache for Explore entity filter
    await generateTrendingDatasets(env);

    // V12: Generate trending agents cache for Rankings
    await generateTrendingAgents(env);
}

// V12: Generate agents cache for Rankings
async function generateTrendingAgents(env: Env) {
    const trendingAgents = await env.DB.prepare(`
        SELECT id, slug, name, author, fni_score, likes,
                cover_image_url, tags, last_updated,
                downloads
        FROM entities 
        WHERE type='agent' AND fni_score IS NOT NULL
        ORDER BY fni_score DESC 
        LIMIT 100
    `).all();

    if (trendingAgents.results && trendingAgents.results.length > 0) {
        await writeToR2(env, 'cache/trending_agents.json', {
            generated_at: new Date().toISOString(),
            version: 'V12',
            count: trendingAgents.results.length,
            agents: trendingAgents.results
        });
        console.log(`[L8] Trending agents: ${trendingAgents.results.length} agents`);
    } else {
        // Create empty placeholder to avoid 404
        await writeToR2(env, 'cache/trending_agents.json', {
            generated_at: new Date().toISOString(),
            version: 'V12',
            count: 0,
            agents: []
        });
        console.log('[L8] Trending agents: empty placeholder created');
    }
}

// V6.3: Generate spaces cache
async function generateTrendingSpaces(env: Env) {
    const trendingSpaces = await env.DB.prepare(`
        SELECT id, slug, name, author, fni_score, likes,
                cover_image_url, tags, last_updated
        FROM entities 
        WHERE type='space' AND fni_score IS NOT NULL
        ORDER BY fni_score DESC 
        LIMIT 100
    `).all();

    if (trendingSpaces.results && trendingSpaces.results.length > 0) {
        await writeToR2(env, 'cache/trending_spaces.json', {
            generated_at: new Date().toISOString(),
            version: 'V6.3',
            count: trendingSpaces.results.length,
            spaces: trendingSpaces.results
        });
        console.log(`[L8] Trending spaces: ${trendingSpaces.results.length} spaces`);
    } else {
        // Create empty placeholder to avoid 404
        await writeToR2(env, 'cache/trending_spaces.json', {
            generated_at: new Date().toISOString(),
            version: 'V6.3',
            count: 0,
            spaces: []
        });
        console.log('[L8] Trending spaces: empty placeholder created');
    }
}

// V6.3: Generate datasets cache
async function generateTrendingDatasets(env: Env) {
    const trendingDatasets = await env.DB.prepare(`
        SELECT id, slug, name, author, fni_score, downloads, likes,
                tags, last_updated
        FROM entities 
        WHERE type='dataset' AND fni_score IS NOT NULL
        ORDER BY fni_score DESC 
        LIMIT 100
    `).all();

    if (trendingDatasets.results && trendingDatasets.results.length > 0) {
        await writeToR2(env, 'cache/trending_datasets.json', {
            generated_at: new Date().toISOString(),
            version: 'V6.3',
            count: trendingDatasets.results.length,
            datasets: trendingDatasets.results
        });
        console.log(`[L8] Trending datasets: ${trendingDatasets.results.length} datasets`);
    } else {
        // Create empty placeholder to avoid 404
        await writeToR2(env, 'cache/trending_datasets.json', {
            generated_at: new Date().toISOString(),
            version: 'V6.3',
            count: 0,
            datasets: []
        });
        console.log('[L8] Trending datasets: empty placeholder created');
    }
}
