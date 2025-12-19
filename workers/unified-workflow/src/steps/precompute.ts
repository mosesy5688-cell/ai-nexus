import { Env } from '../config/types';
import {
    generateTrendingAndLeaderboard,
    generateNeuralGraph,
    generateCategoryStats,
    generateEntityLinksAndBenchmarks,
} from '../utils/precompute-helpers';
import { generateTrendingSpaces, generateTrendingDatasets, generateEntityLinks } from '../utils/entity-precompute';
import { generateRankings } from '../utils/ranking-generator';
import { generateSitemaps } from '../utils/sitemap-generator';

export async function runPrecomputeStep(env: Env) {
    console.log('[L8 Orchestrator] Starting full cache regeneration...');

    // 0. Rankings (Paginated)
    try {
        await generateRankings(env);
        console.log('[L8] ✅ Rankings complete');
    } catch (err) {
        console.error('[L8] ❌ Rankings failed:', err);
    }

    // 1. Trending & Leaderboard
    try {
        await generateTrendingAndLeaderboard(env);
        console.log('[L8] ✅ Trending complete');
    } catch (err) {
        console.error('[L8] ❌ Trending failed:', err);
    }

    // 2. Neural Graph
    try {
        await generateNeuralGraph(env);
        console.log('[L8] ✅ Neural Graph complete');
    } catch (err) {
        console.error('[L8] ❌ Neural Graph failed:', err);
    }

    // 3. Category Stats - V6.0 Critical
    try {
        await generateCategoryStats(env);
        console.log('[L8] ✅ Category Stats complete');
    } catch (err) {
        console.error('[L8] ❌ Category Stats failed:', err);
    }

    // 4. Benchmarks & Entity Links
    try {
        await generateEntityLinksAndBenchmarks(env);
        console.log('[L8] ✅ Benchmarks complete');
    } catch (err) {
        console.error('[L8] ❌ Benchmarks failed:', err);
    }

    // 5. Sitemaps - V6.1+ SEO Optimization (Constitution Art 6.3)
    try {
        await generateSitemaps(env);
        console.log('[L8] ✅ Sitemaps complete');
    } catch (err) {
        console.error('[L8] ❌ Sitemaps failed:', err);
    }

    // 6. V6.2: Trending Spaces Cache
    try {
        await generateTrendingSpaces(env);
        console.log('[L8] ✅ Trending Spaces complete');
    } catch (err) {
        console.error('[L8] ❌ Trending Spaces failed:', err);
    }

    // 7. V6.2: Trending Datasets Cache
    try {
        await generateTrendingDatasets(env);
        console.log('[L8] ✅ Trending Datasets complete');
    } catch (err) {
        console.error('[L8] ❌ Trending Datasets failed:', err);
    }

    // 8. V6.2: Entity Links Cache
    try {
        await generateEntityLinks(env);
        console.log('[L8] ✅ Entity Links complete');
    } catch (err) {
        console.error('[L8] ❌ Entity Links failed:', err);
    }

    console.log('[L8 Orchestrator] Cache regeneration complete.');
}
