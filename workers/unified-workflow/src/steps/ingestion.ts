
import { Env } from '../config/types';
import { cleanModel, validateModel, routeToShadowDB, ValidationResult } from '../utils/entity-helper';
import { enrichModel } from '../utils/model-enricher';

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

    // List pending files in raw-data/
    console.log('[Ingest] Listing files in raw-data/...');
    const listed = await env.R2_ASSETS.list({
        prefix: 'raw-data/',
        limit: 100,
        startAfter: checkpoint.lastId || undefined
    });

    console.log(`[Ingest] R2 list returned: ${listed.objects.length} total objects, truncated: ${listed.truncated}`);

    const jsonFiles = listed.objects.filter((obj: any) => obj.key.endsWith('.json'));

    if (jsonFiles.length === 0) {
        console.log('[Ingest] No pending files in raw-data/');
        return { filesProcessed: 0, modelsIngested: 0, messagesQueued: 0 };
    }

    console.log(`[Ingest] Found ${jsonFiles.length} files to process`);

    // V6.0: Increased for faster bulk processing (Constitution Art 1.1 compliant)
    const MAX_FILES_PER_RUN = 100; // Doubled from 50 for V6.0
    let totalModels = 0;
    let filesProcessed = 0;
    let messagesQueued = 0;

    for (const fileObj of jsonFiles.slice(0, MAX_FILES_PER_RUN)) {
        try {
            console.log(`[Ingest] Fetching ${fileObj.key}...`);
            const file = await env.R2_ASSETS.get(fileObj.key);
            if (!file) {
                console.log(`[Ingest] File not found: ${fileObj.key}`);
                continue;
            }

            const models = await file.json() as any[];
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

            // Route invalid models to Shadow DB
            for (const { model, validation } of invalidModels) {
                await routeToShadowDB(env.DB, model, validation);
            }

            // Step 1: Write valid models to D1 (for indexing and FNI)
            for (let i = 0; i < validModels.length; i += 50) {
                const batch = validModels.slice(i, i + 50);
                const stmts = batch.map(m =>
                    env.DB.prepare(`
                        INSERT OR REPLACE INTO entities (
                            id, slug, name, author, description, tags,
                            likes, downloads, cover_image_url, body_content_url,
                            source_trail, license_spdx, has_ollama, has_gguf,
                            last_updated, primary_category, category_confidence,
                            category_status, size_bucket, size_source
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).bind(
                        m.id, m.slug, m.name, m.author, m.description, m.tags,
                        m.likes, m.downloads, m.cover_image_url, m.body_content_url,
                        m.source_trail, m.license_spdx, m.has_ollama, m.has_gguf,
                        m.last_updated, m.primary_category, m.category_confidence,
                        m.category_status, m.size_bucket, m.size_source
                    )
                );
                await env.DB.batch(stmts);
                console.log(`[Ingest] D1 batch ${Math.floor(i / 50) + 1}: ${batch.length} models`);
            }

            // Step 2: Send to HYDRATION_QUEUE for R2 cache materialization
            // Art 2.4: Batch ≤ 100, Message ≤ 64KB
            const QUEUE_BATCH_SIZE = 50; // Conservative for message size
            for (let i = 0; i < validModels.length; i += QUEUE_BATCH_SIZE) {
                const batch = validModels.slice(i, i + QUEUE_BATCH_SIZE);

                // Send individual messages for parallel processing
                const messages = batch.map(model => ({
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

            // V6.0: Delete after successful D1 write (L1 Harvester is source of truth)
            await env.R2_ASSETS.delete(fileObj.key);
            console.log(`[Ingest] Processed and deleted: ${fileObj.key}`);
        } catch (error) {
            console.error(`[Ingest] Error processing ${fileObj.key}:`, error);
        }
    }

    console.log(`[Ingest] Complete: ${filesProcessed} files, ${totalModels} models, ${messagesQueued} queued`);
    return { filesProcessed, modelsIngested: totalModels, messagesQueued };
}
