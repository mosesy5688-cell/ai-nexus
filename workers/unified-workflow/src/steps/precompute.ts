
import { Env } from '../config/types';
import {
    generateTrendingAndLeaderboard,
    generateNeuralGraph,
    generateCategoryStats,
    generateEntityLinksAndBenchmarks,
    generateRankings
} from '../utils/precompute-helpers';

export async function runPrecomputeStep(env: Env) {
    console.log('[L8 Orchestrator] Starting full cache regeneration...');

    // 0. Rankings (Paginated)
    await generateRankings(env);

    // 1. Trending & Leaderboard
    await generateTrendingAndLeaderboard(env);

    // 2. Neural Graph
    await generateNeuralGraph(env);

    // 3. Category Stats
    await generateCategoryStats(env);

    // 4. Benchmarks & Entity Links
    await generateEntityLinksAndBenchmarks(env);

    console.log('[L8 Orchestrator] Cache regeneration complete.');
}
