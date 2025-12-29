/**
 * FNI (Freshness-Novelty Index) Calculation Utilities
 * Extracted from entity-helper.ts for CES Art 5.1 compliance (< 250 lines)
 * 
 * Constitution V4.7: FNI = P × 30% + V × 30% + C × 20% + U × 20%
 */

/**
 * Derive entity type from UMID prefix
 * Art.X-Entity: Frontend must render by entity.definition
 */
export function deriveEntityType(id: string): string {
    if (!id) return 'model';
    if (id.startsWith('hf-dataset--')) return 'dataset';
    if (id.startsWith('hf-space--')) return 'space';
    if (id.startsWith('benchmark--')) return 'benchmark';
    if (id.startsWith('arxiv--')) return 'paper';
    if (id.startsWith('agent--') || id.startsWith('github-agent--')) return 'agent';
    return 'model';
}

/**
 * V4.9 Art.X-Entity-FNI: Remove FNI fields from non-Model entities
 * FNI only applies to Model entities; non-model: fni_score = null (not 0)
 */
export function stripFNIFromNonModel(entity: any): any {
    const entityType = deriveEntityType(entity.id || entity.umid);
    if (entityType !== 'model') {
        delete entity.fni_score;
        delete entity.fni_p;
        delete entity.fni_v;
        delete entity.fni_c;
        delete entity.fni_u;
        delete entity.fni_rank;
        delete entity.fni_trend;
        delete entity.fni_percentile;
    }
    return entity;
}

/**
 * Compute FNI scores using V4.7 canonical weights
 * FNI = P × 30% + V × 30% + C × 20% + U × 20%
 */
export function computeFNI(
    model: any,
    oldData?: { downloads: number; likes: number }
): { score: number; p: number; v: number; c: number; u: number } {
    const downloads = model.downloads || 0;
    const likes = model.likes || 0;
    const maxDownloads = 1000000;
    const maxLikes = 500000;
    const p = Math.min(100, (Math.min(likes / maxLikes, 1) * 40 + Math.min(downloads / maxDownloads, 1) * 60));

    let v = 0;
    if (oldData) {
        const downloadGrowth = downloads - (oldData.downloads || 0);
        const likeGrowth = likes - (oldData.likes || 0);
        const downloadVelocity = Math.min(100, (downloadGrowth / 100000) * 100);
        const likeVelocity = Math.min(100, (likeGrowth / 10000) * 100);
        v = Math.max(0, (downloadVelocity * 0.7 + likeVelocity * 0.3));
    }

    let c = 0;
    if (model.license_spdx) c += 30;
    if (model.body_content_url) c += 40;
    if (model.source_trail) c += 30;

    let u = 0;
    if (model.has_ollama) u += 50;
    if (model.has_gguf) u += 50;

    const score = (p * 0.30) + (v * 0.30) + (c * 0.20) + (u * 0.20);

    return {
        score: Math.min(100, Math.round(score)),
        p: Math.round(p),
        v: Math.round(v),
        c,
        u
    };
}
