import { Env } from '../config/types';
import { cleanModel, validateModel, routeToShadowDB, ValidationResult } from '../utils/entity-helper';
import { enrichModel } from '../utils/model-enricher';
import { buildExtendedMeta } from '../utils/extended-meta';


/**
 * V5.2.1 Ingestion Step with HYDRATION_QUEUE
 * Constitution Art 2.4: Uses Queue for parallel entity materialization
 * 
 * Flow: R2 raw-data/ → D1 (indexing) → HYDRATION_QUEUE → Consumer → R2 cache/
 */
export async function runIngestionStep(env: Env, checkpoint: any): Promise<{ filesProcessed: number; modelsIngested: number; messagesQueued: number }> {
    console.log('[Ingest] Starting V5.2.1 Queue-enabled ingestion...');
    console.log(`[L1] Resume from checkpoint: lastId=${checkpoint.lastId}`);

    // Art 2.3: Check Kill-Switch
    const systemPause = await env.KV?.get('SYSTEM_PAUSE');
    if (systemPause === 'true') {
        console.log('[Ingest] SYSTEM_PAUSE active, skipping ingestion');
        return { filesProcessed: 0, modelsIngested: 0, messagesQueued: 0 };
    }

    // V9.2: Read L1 manifest to get job_id and batch list
    // Per DATA_INTEGRITY_PLAN: L8 must NOT delete R2 files (L5 needs them)
    // Instead, track processed job_id in KV to avoid re-processing
    let manifest: any = null;
    try {
        const manifestFile = await env.R2_ASSETS.get('ingest/manifest.json');
        if (manifestFile) {
            manifest = await manifestFile.json() as any;
            console.log(`[Ingest] Manifest: job_id=${manifest.job_id}, batches=${manifest.batches?.length || 0}`);
        }
    } catch (e) { console.error('[Ingest] Manifest read failed:', e); }

    if (!manifest?.batches?.length) {
        console.log('[Ingest] No manifest or batches found');
        return { filesProcessed: 0, modelsIngested: 0, messagesQueued: 0 };
    }

    // V9.2: Check if this manifest was already processed
    const lastProcessedJobId = await env.KV?.get('LAST_PROCESSED_L1_JOB_ID');
    if (lastProcessedJobId === manifest.job_id) {
        console.log(`[Ingest] Manifest job_id=${manifest.job_id} already processed. Skipping.`);
        return { filesProcessed: 0, modelsIngested: 0, messagesQueued: 0 };
    }

    console.log(`[Ingest] New manifest detected: ${manifest.job_id} (last: ${lastProcessedJobId || 'none'})`);

    // Get batch files from manifest
    const jsonFiles = manifest.batches.map((b: any) => ({ key: b.key }));
    console.log(`[Ingest] Total batch files: ${jsonFiles.length}`);

    // V9.2.3: Process 5 batches per Cron run
    // L1 now produces 500 entities/batch, safe for API limit
    const MAX_FILES_PER_RUN = 5;
    let batchOffset = 0;
    const offsetKey = `BATCH_OFFSET_${manifest.job_id}`;
    try {
        const storedOffset = await env.KV?.get(offsetKey);
        if (storedOffset) batchOffset = parseInt(storedOffset, 10) || 0;
    } catch (e) { console.log('[Ingest] KV offset read failed'); }

    // If all batches processed, mark job as complete
    if (batchOffset >= jsonFiles.length) {
        console.log(`[Ingest] All batches processed for job ${manifest.job_id}. Marking complete.`);
        await env.KV?.put('LAST_PROCESSED_L1_JOB_ID', manifest.job_id);
        await env.KV?.delete(offsetKey);
        return { filesProcessed: 0, modelsIngested: 0, messagesQueued: 0 };
    }

    console.log(`[Ingest] Processing batches ${batchOffset} to ${Math.min(batchOffset + MAX_FILES_PER_RUN, jsonFiles.length) - 1}`);
    let totalModels = 0, filesProcessed = 0, messagesQueued = 0;

    // V9.2: Process from current offset
    const batchesToProcess = jsonFiles.slice(batchOffset, batchOffset + MAX_FILES_PER_RUN);
    console.log(`[Ingest] Processing ${batchesToProcess.length} batches this run...`);
    for (const fileObj of batchesToProcess) {
        try {
            console.log(`[Ingest] Fetching ${fileObj.key}...`);
            const file = await env.R2_ASSETS.get(fileObj.key);
            if (!file) {
                console.log(`[Ingest] File not found: ${fileObj.key}`);
                continue;
            }

            // V7.1: Handle gzip compressed files
            let models: any[];
            if (fileObj.key.endsWith('.gz')) {
                // Decompress gzip content
                const compressed = await file.arrayBuffer();
                const decompressed = new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new Uint8Array(compressed));
                            controller.close();
                        }
                    }).pipeThrough(new DecompressionStream('gzip'))
                );
                models = await decompressed.json() as any[];
            } else {
                models = await file.json() as any[];
            }
            console.log(`[Ingest] Processing ${fileObj.key}: ${models.length} models`);

            // Clean and validate models
            const cleanedModels = models.map(m => cleanModel(m));
            const validModels: any[] = [];
            const invalidModels: { model: any; validation: ValidationResult }[] = [];

            for (const m of cleanedModels) {
                const validation = validateModel(m);
                if (validation.valid) {
                    // V6.0: Enrich with category and size
                    const enriched = enrichModel(m);
                    validModels.push({ ...m, ...enriched });
                } else {
                    invalidModels.push({ model: m, validation });
                }
            }

            console.log(`[Ingest] Validation: ${validModels.length} valid, ${invalidModels.length} invalid`);

            // V9.2.3: Shadow DB enabled - L1 batch size reduced to 500
            // Art 2.1: Route invalid models to Shadow DB for quarantine
            for (const { model, validation } of invalidModels) {
                await routeToShadowDB(env.DB, model, validation);
            }

            // Step 1: Write valid models to D1 (Index-Only, per Phase A.1)
            // Phase B.8: Added params_billions, context_length, architecture, meta_json
            for (let i = 0; i < validModels.length; i += 50) {
                const batch = validModels.slice(i, i + 50);
                const stmts = batch.map(m => {
                    // Build extended meta with Phase B.8 fields
                    const extendedMeta = buildExtendedMeta(m);
                    const metaJson = JSON.stringify({ extended: extendedMeta });

                    return env.DB.prepare(`
                        INSERT OR REPLACE INTO entities (
                            id, type, name, author, 
                            likes, downloads, fni_score,
                            last_updated,
                            pipeline_tag, primary_category, tags,
                            source, source_url, link_status,
                            params_billions, context_length, architecture, meta_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).bind(
                        m.id,
                        m.type || 'model',
                        m.name || '',
                        m.author || '',
                        m.likes || 0,
                        m.downloads || 0,
                        m.fni_score || 0,
                        m.last_modified || m.last_updated || new Date().toISOString(),
                        m.pipeline_tag || null,
                        m.primary_category || null,
                        typeof m.tags === 'string' ? m.tags : JSON.stringify(m.tags || []),
                        m.source || 'huggingface',
                        m.source_url || null,
                        m.link_status || 'ok',
                        extendedMeta.params_billions ?? null,
                        extendedMeta.context_length ?? null,
                        extendedMeta.architecture || null,
                        metaJson
                    );
                });
                await env.DB.batch(stmts);
                console.log(`[Ingest] D1 batch ${Math.floor(i / 50) + 1}: ${batch.length} models (Phase B.8 schema)`);
            }

            // Step 2: Send to HYDRATION_QUEUE for R2 cache materialization
            // Art 2.4: Batch ≤ 100, Message ≤ 64KB
            const QUEUE_BATCH_SIZE = 50; // Conservative for message size
            for (let i = 0; i < validModels.length; i += QUEUE_BATCH_SIZE) {
                const batch = validModels.slice(i, i + QUEUE_BATCH_SIZE);

                // Send individual messages for parallel processing
                const messages = batch.map((model: any) => ({
                    body: {
                        model,
                        relatedLinks: [], // Will be computed by consumer
                        source: fileObj.key
                    }
                }));

                try {
                    await env.HYDRATION_QUEUE.sendBatch(messages);
                    messagesQueued += messages.length;
                    console.log(`[Ingest] Queued batch: ${messages.length} messages`);
                } catch (queueError) {
                    console.error('[Ingest] Queue send failed:', queueError);
                    // Continue processing, D1 write succeeded
                }
            }

            totalModels += validModels.length;
            filesProcessed++;

            // V9.2: DO NOT delete R2 files - L5 Heavy Compute needs them
            // L1 Harvester will overwrite old files on next run
            console.log(`[Ingest] Processed: ${fileObj.key}`);
        } catch (error) {
            console.error(`[Ingest] Error processing ${fileObj.key}:`, error);
        }
    }

    console.log(`[Ingest] Complete: ${filesProcessed} files, ${totalModels} models, ${messagesQueued} queued`);

    // V9.2.1 FIX: Use batchesToProcess.length to ensure offset advances even if files are missing
    // This prevents L8 from getting stuck on deleted files
    const newOffset = batchOffset + batchesToProcess.length;
    try {
        await env.KV?.put(offsetKey, String(newOffset));
        console.log(`[Ingest] Saved offset ${newOffset} for job ${manifest.job_id} (${filesProcessed} files actually processed)`);
    } catch (e) { console.log('[Ingest] KV offset save failed'); }

    return { filesProcessed, modelsIngested: totalModels, messagesQueued };
}

