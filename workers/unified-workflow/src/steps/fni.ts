
import { Env } from '../config/types';
import { computeFNI } from '../utils/entity-helper';

export async function runFNIStep(env: Env): Promise<{ modelsCalculated: number; mode: string }> {
    const hour = new Date().getUTCHours();
    const isFullRecalc = hour === 4;
    const mode = isFullRecalc ? 'full' : 'incremental';

    console.log(`[FNI] Running ${mode.toUpperCase()} calculation (hour=${hour})`);

    // On full recalc, take a daily snapshot first
    if (isFullRecalc) {
        console.log('[FNI] Taking daily snapshot for Velocity tracking...');
        await env.DB.prepare(`
            INSERT INTO models_history (model_id, downloads, likes)
            SELECT id, downloads, likes FROM models
        `).run();
        console.log('[FNI] Snapshot complete');
    }

    // V5.2.1: Only calculate FNI for actual models, not datasets/papers/repos
    // Models use huggingface-- or ollama prefix; others (arxiv--, hf-dataset--, github--) are excluded
    const modelFilter = `(id LIKE 'huggingface%' OR id LIKE 'ollama%')`;

    const query = isFullRecalc
        ? `SELECT id, downloads, likes, license_spdx, body_content_url, 
           source_trail, has_ollama, has_gguf FROM models
           WHERE ${modelFilter}`
        : `SELECT id, downloads, likes, license_spdx, body_content_url, 
           source_trail, has_ollama, has_gguf FROM models 
           WHERE ${modelFilter} AND last_updated > datetime('now', '-1 day')`;

    const models = await env.DB.prepare(query).all();

    if (!models.results || models.results.length === 0) {
        console.log('[FNI] No models to update');
        return { modelsCalculated: 0, mode };
    }

    // Fetch historical data for velocity calculation
    const historyMap = new Map<string, { downloads: number; likes: number }>();
    if (isFullRecalc) {
        const history = await env.DB.prepare(`
            SELECT model_id, downloads, likes 
            FROM models_history 
            WHERE recorded_at < datetime('now', '-6 days')
            AND recorded_at > datetime('now', '-8 days')
        `).all();
        for (const h of (history.results || []) as any[]) {
            historyMap.set(h.model_id, { downloads: h.downloads || 0, likes: h.likes || 0 });
        }
        console.log(`[FNI] Found ${historyMap.size} models with 7-day history`);
    }

    const updates = models.results.map((m: any) => {
        const oldData = historyMap.get(m.id);
        const fni = computeFNI(m, oldData);
        return env.DB.prepare(`
            UPDATE models SET 
                fni_score = ?, fni_p = ?, fni_v = ?, fni_c = ?, fni_u = ?
            WHERE id = ?
        `).bind(fni.score, fni.p, fni.v, fni.c, fni.u, m.id);
    });

    // Batch update in chunks of 50
    for (let i = 0; i < updates.length; i += 50) {
        const chunk = updates.slice(i, i + 50);
        await env.DB.batch(chunk);
    }

    console.log(`[FNI] ${mode} calculation completed: ${models.results.length} models`);
    return { modelsCalculated: models.results.length, mode };
}
