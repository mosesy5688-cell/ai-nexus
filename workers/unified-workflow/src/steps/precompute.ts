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
    console.log('[L8 Orchestrator] Starting lightweight cache regeneration...');
    console.log('[L8] Note: Rankings/Stats migrated to L5 Sidecar (V7.2 Phase 3)');

    // 0. Rankings (Paginated) - MIGRATED TO L5
    // V7.2 Phase 3: Now handled by L5 Sidecar (scripts/l5/rankings-compute.js)
    // See: l5-heavy-compute.yml -> compute-rankings job
    console.log('[L8] ⏭️ Rankings skipped (migrated to L5 Sidecar)');

    // 1. Trending & Leaderboard - Keep in L8 (lightweight D1 query)
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

    // 3. Category Stats - MIGRATED TO L5
    // V7.2 Phase 3: Now handled by L5 Sidecar (scripts/l5/rankings-compute.js L127-141)
    // Generates: cache/category_stats.json with full category breakdown
    console.log('[L8] ⏭️ Category Stats skipped (migrated to L5 Sidecar)');

    // 4. Benchmarks & Entity Links
    try {
        await generateEntityLinksAndBenchmarks(env);
        console.log('[L8] ✅ Benchmarks complete');
    } catch (err) {
        console.error('[L8] ❌ Benchmarks failed:', err);
    }

    // 5. Sitemaps - DEPRECATED: Now handled by L5 Sidecar (l5-sitemap.yml)
    // V6.2: Migrated to L5 for Constitution compliance (CPU-intensive task)
    // See: SPEC_SITEMAP_V6.1.md, MASTER_EXECUTION_PLAN_V6.2.md
    // await generateSitemaps(env);
    console.log('[L8] ⏭️ Sitemaps skipped (migrated to L5 Sidecar)');

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
