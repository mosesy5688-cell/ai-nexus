import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

/**
 * V4.1 Unified Workflow - Single Cron, Multiple Tasks
 * 
 * FIXED: Step callbacks now perform I/O directly in run() scope
 * to avoid 'this' context loss during step serialization.
 */

interface Env {
    DB: D1Database;
    R2_ASSETS: R2Bucket;
    UNIFIED_WORKFLOW: Workflow;
}

interface WorkflowResult {
    status: string;
    ingest?: { filesProcessed: number; modelsIngested: number };
    fni?: { modelsCalculated: number; mode: string };
    duration_ms: number;
}

// ============================================================
// UNIFIED WORKFLOW CLASS
// ============================================================

export class UnifiedWorkflow extends WorkflowEntrypoint<Env> {

    async run(event: WorkflowEvent<{}>, step: WorkflowStep): Promise<WorkflowResult> {
        const startTime = Date.now();
        let result: WorkflowResult = { status: 'completed', duration_ms: 0 };

        // Capture env at the class level - this.env should work in the run scope
        const env = this.env;

        // ---------------------------------------------------------
        // STEP 1: INGEST (High Frequency)
        // ---------------------------------------------------------
        const ingestResult = await step.do('ingest-raw-data', async () => {
            console.log('[Ingest] Starting ingestion...');

            // List pending files in raw-data/
            console.log('[Ingest] Listing files in raw-data/...');
            const listed = await env.R2_ASSETS.list({
                prefix: 'raw-data/',
                limit: 100
            });

            console.log(`[Ingest] R2 list returned: ${listed.objects.length} total objects, truncated: ${listed.truncated}`);

            // Debug: log all object keys
            if (listed.objects.length > 0) {
                console.log('[Ingest] Objects found:', listed.objects.map(o => o.key).join(', '));
            }

            const jsonFiles = listed.objects.filter(obj => obj.key.endsWith('.json'));
            console.log(`[Ingest] JSON files after filter: ${jsonFiles.length}`);

            if (jsonFiles.length === 0) {
                console.log('[Ingest] No pending files in raw-data/');
                return { filesProcessed: 0, modelsIngested: 0 };
            }

            console.log(`[Ingest] Found ${jsonFiles.length} files to process`);

            // V4.1 HUNGRY MODE: Process up to 20 files per run (was 1)
            const MAX_FILES_PER_RUN = 20;
            let totalModels = 0;
            let filesProcessed = 0;

            for (const fileObj of jsonFiles.slice(0, MAX_FILES_PER_RUN)) { // Process up to 20 files per run
                try {
                    console.log(`[Ingest] Fetching ${fileObj.key}...`);
                    const file = await env.R2_ASSETS.get(fileObj.key);
                    if (!file) {
                        console.log(`[Ingest] File not found: ${fileObj.key}`);
                        continue;
                    }

                    const models = await file.json() as any[];
                    console.log(`[Ingest] Processing ${fileObj.key}: ${models.length} models`);

                    // Clean and prepare models
                    const cleanedModels = models.map(m => cleanModel(m));

                    // Write to D1 in batches
                    for (let i = 0; i < cleanedModels.length; i += 50) {
                        const batch = cleanedModels.slice(i, i + 50);
                        const stmts = batch.map(m =>
                            env.DB.prepare(`
                                INSERT OR REPLACE INTO models (
                                    id, slug, name, author, description, tags,
                                    likes, downloads, cover_image_url, body_content_url,
                                    source_trail, license_spdx, has_ollama, has_gguf,
                                    last_updated
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `).bind(
                                m.id, m.slug, m.name, m.author, m.description, m.tags,
                                m.likes, m.downloads, m.cover_image_url, m.body_content_url,
                                m.source_trail, m.license_spdx, m.has_ollama, m.has_gguf,
                                m.last_updated
                            )
                        );
                        await env.DB.batch(stmts);
                        console.log(`[Ingest] Wrote batch ${Math.floor(i / 50) + 1}: ${batch.length} models`);
                    }

                    totalModels += cleanedModels.length;
                    filesProcessed++;

                    // Archive processed file
                    const archiveFile = await env.R2_ASSETS.get(fileObj.key);
                    if (archiveFile) {
                        const today = new Date().toISOString().split('T')[0];
                        const archiveKey = `processed/${today}/${fileObj.key.split('/').pop()}`;
                        await env.R2_ASSETS.put(archiveKey, archiveFile.body);
                        await env.R2_ASSETS.delete(fileObj.key);
                        console.log(`[Ingest] Archived: ${fileObj.key} -> ${archiveKey}`);
                    }
                } catch (error) {
                    console.error(`[Ingest] Error processing ${fileObj.key}:`, error);
                }
            }

            return { filesProcessed, modelsIngested: totalModels };
        });
        result.ingest = ingestResult;

        // ---------------------------------------------------------
        // STEP 2: FNI CALCULATION (Smart Schedule)
        // ---------------------------------------------------------
        const fniResult = await step.do('calculate-fni', async () => {
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

            const query = isFullRecalc
                ? `SELECT id, downloads, likes, license_spdx, body_content_url, 
                   source_trail, has_ollama, has_gguf FROM models`
                : `SELECT id, downloads, likes, license_spdx, body_content_url, 
                   source_trail, has_ollama, has_gguf FROM models 
                   WHERE last_updated > datetime('now', '-1 day')`;

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
        });
        result.fni = fniResult;

        // ---------------------------------------------------------
        // STEP 3: MONITORING
        // ---------------------------------------------------------
        result.duration_ms = Date.now() - startTime;
        await step.do('log-execution', async () => {
            const safeWorkflowId = event.id || 'unknown';
            const safeStatus = result?.status || 'completed';
            const safeIngestCount = result?.ingest?.modelsIngested ?? 0;
            const safeFniCount = result?.fni?.modelsCalculated ?? 0;
            const safeDurationMs = result?.duration_ms ?? 0;

            console.log(`[Monitor] Logging: workflowId=${safeWorkflowId}, ingest=${safeIngestCount}, fni=${safeFniCount}`);

            await env.DB.prepare(`
                INSERT INTO workflow_logs (
                    workflow_id, workflow_type, status, processed_count, duration_ms, created_at
                ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).bind(
                safeWorkflowId,
                'unified',
                safeStatus,
                safeIngestCount + safeFniCount,
                safeDurationMs
            ).run();

            console.log(`[Monitor] Logged successfully`);
        });

        return result;
    }
}

// ============================================================
// HELPER FUNCTIONS (outside class to avoid 'this' issues)
// ============================================================

function cleanModel(model: any): any {
    const id = model.id || model.modelId || '';
    const slug = id.replace(/\//g, '-');

    const cleanText = (text: string | null): string => {
        if (!text) return '';
        return String(text)
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 2000);
    };

    return {
        id: id,
        slug: slug,
        name: cleanText(model.title || model.name || model.id || ''),
        author: model.author || '',
        description: cleanText(model.description || ''),
        tags: JSON.stringify(model.tags || (model.pipeline_tag ? [model.pipeline_tag] : [])),
        likes: model.popularity || model.likes || 0,
        downloads: model.downloads || 0,
        // V4.1 Fix: Match orchestrator field names
        cover_image_url: model.raw_image_url || model.cover_image_url || '',
        body_content_url: model.body_content_url || '',
        source_trail: typeof model.source_trail === 'string'
            ? model.source_trail
            : JSON.stringify(model.source_trail || { source: 'huggingface', fetched_at: new Date().toISOString() }),
        license_spdx: model.license_spdx || model.license || '',
        has_ollama: model.has_ollama ? 1 : 0,
        has_gguf: model.has_gguf ? 1 : 0,
        last_updated: new Date().toISOString()
    };
}

/**
 * Compute FNI scores using V4.7 canonical weights
 * FNI = P × 30% + V × 30% + C × 20% + U × 20%
 * 
 * @param model - Current model data
 * @param oldData - Optional 7-day old data for velocity calculation
 */
function computeFNI(
    model: any,
    oldData?: { downloads: number; likes: number }
): { score: number; p: number; v: number; c: number; u: number } {
    // P: Popularity (30%) - based on downloads and likes
    const downloads = model.downloads || 0;
    const likes = model.likes || 0;
    const maxDownloads = 1000000;
    const maxLikes = 500000;
    const p = Math.min(100,
        (Math.min(likes / maxLikes, 1) * 40 + Math.min(downloads / maxDownloads, 1) * 60)
    );

    // V: Velocity (30%) - 7-day growth rate
    let v = 0;
    if (oldData) {
        const downloadGrowth = downloads - (oldData.downloads || 0);
        const likeGrowth = likes - (oldData.likes || 0);
        // Normalize: 100K downloads/week = 100, 10K likes/week = 100
        const downloadVelocity = Math.min(100, (downloadGrowth / 100000) * 100);
        const likeVelocity = Math.min(100, (likeGrowth / 10000) * 100);
        v = Math.max(0, (downloadVelocity * 0.7 + likeVelocity * 0.3));
    }

    // C: Credibility (20%) - documentation, license, source trail
    let c = 0;
    if (model.license_spdx) c += 30;
    if (model.body_content_url) c += 40;
    if (model.source_trail) c += 30;

    // U: Utility (20%) - runtime ecosystem support
    let u = 0;
    if (model.has_ollama) u += 50;
    if (model.has_gguf) u += 50;

    // V4.7 Constitution: P×30% + V×30% + C×20% + U×20%
    const score = (p * 0.30) + (v * 0.30) + (c * 0.20) + (u * 0.20);

    return {
        score: Math.min(100, Math.round(score)),
        p: Math.round(p),
        v: Math.round(v),
        c,
        u
    };
}

// ============================================================
// HTTP & CRON HANDLERS
// ============================================================

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/debug-r2') {
            try {
                console.log('[Debug] Listing R2 raw-data/...');
                const listed = await env.R2_ASSETS.list({
                    prefix: 'raw-data/',
                    limit: 100
                });

                const result = {
                    totalObjects: listed.objects.length,
                    truncated: listed.truncated,
                    objects: listed.objects.map(o => ({
                        key: o.key,
                        size: o.size,
                        uploaded: o.uploaded
                    }))
                };

                return new Response(JSON.stringify(result, null, 2), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (error) {
                return new Response(JSON.stringify({ error: String(error) }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        // Manual trigger endpoint for force flush
        if (url.pathname === '/trigger') {
            try {
                console.log('[Trigger] Manual workflow trigger...');
                const instance = await env.UNIFIED_WORKFLOW.create();
                return new Response(JSON.stringify({
                    status: 'triggered',
                    instanceId: instance.id,
                    message: 'Unified Workflow instance created. Check logs for progress.'
                }, null, 2), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (error) {
                return new Response(JSON.stringify({ error: String(error) }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        return new Response('Unified Workflow V4.1 (Hungry Mode)\n\nEndpoints:\n- /debug-r2 - Debug R2 listing\n- /trigger - Manual workflow trigger', {
            headers: { 'Content-Type': 'text/plain' }
        });
    },

    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        console.log(`[Cron] Triggered at ${new Date().toISOString()}`);
        try {
            const instance = await env.UNIFIED_WORKFLOW.create();
            console.log(`[Cron] Started workflow instance: ${instance.id}`);
        } catch (error) {
            console.error('[Cron] Failed to start workflow:', error);
        }
    }
};
