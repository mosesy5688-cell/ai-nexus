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
    const trending = await env.DB.prepare(`
        SELECT id, slug, name, author, fni_score, downloads, likes,
                cover_image_url, tags, has_ollama, has_gguf,
                last_updated, pwc_benchmarks
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
