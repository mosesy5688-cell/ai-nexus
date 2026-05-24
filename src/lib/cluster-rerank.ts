/**
 * V27.44: Cluster semantic rerank helper, extracted from search.ts to keep
 * the API route under CES Art 5.1 250-line limit.
 *
 * Applies query-time semantic similarity (S factor) to hydrated search
 * results, updates fni_score per FNI v2.0 weights, persists fni_s back to
 * each row so API consumers see the query-time semantic contribution.
 */
import { embedQuery } from './semantic-engine.js';
import { initClusterSemantic, getClusterSemanticScore, isReady as isClusterReady } from './cluster-semantic-engine.js';

export async function applyClusterSemanticRerank(
    hydrated: any[],
    q: string,
    env: any,
    r2Bucket: any,
    isDev: boolean,
): Promise<void> {
    if (!env?.AI || hydrated.length === 0) return;
    try {
        await initClusterSemantic(r2Bucket, isDev);
        if (!isClusterReady()) return;
        const qEmb = await embedQuery(q, env);
        if (!qEmb) return;
        for (const r of hydrated) {
            const S = getClusterSemanticScore(qEmb, r.id);
            r.fni_s = Math.round(S * 10) / 10;
            r.fni_score = Math.min(
                99.9,
                Math.round(
                    (0.35 * S + 0.25 * (r.fni_a || 0) + 0.15 * (r.fni_p || 0) + 0.15 * (r.fni_r || 0) + 0.10 * (r.fni_q || 0)) * 10,
                ) / 10,
            );
        }
        hydrated.sort((a: any, b: any) => (b.fni_score || 0) - (a.fni_score || 0));
    } catch (e: any) {
        console.warn(`[SSR Search] Cluster semantic rerank failed: ${e.message}`);
    }
}
