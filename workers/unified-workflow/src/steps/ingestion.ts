
import { Env } from '../config/types';
import { cleanModel, validateModel, routeToShadowDB, ValidationResult } from '../utils/entity-helper';
import { enrichModel } from '../utils/model-enricher';

/**
 * Phase B.8: User Understanding Infrastructure
 * Helper functions for technical specs extraction
 */

// Whitelist of valid quantization formats
const VALID_QUANT = ['GGUF', 'AWQ', 'GPTQ', 'EXL2'];

/**
 * Extract quantization formats from tags
 * Constitution: Only accept known, deployable formats
 */
function extractQuantizations(tags: string[] = []): string[] {
    const quants = new Set<string>();
    const lowerTags = tags.map(t => (t || '').toLowerCase());

    if (lowerTags.some(t => t.includes('gguf'))) quants.add('GGUF');
    if (lowerTags.some(t => t.includes('awq'))) quants.add('AWQ');
    if (lowerTags.some(t => t.includes('gptq'))) quants.add('GPTQ');
    if (lowerTags.some(t => t.includes('exl2'))) quants.add('EXL2');

    return Array.from(quants);
}

/**
 * Safely parse numeric values (params, context_length)
 */
function parseNumber(input: any): number | null {
    if (input === null || input === undefined) return null;
    const num = typeof input === 'number' ? input : parseFloat(input);
    return isNaN(num) ? null : num;
}

/**
 * Build extended meta object with Phase B.8 fields
 * Supports Partial - avoids L8 write failures
 */
function buildExtendedMeta(model: any): Record<string, any> {
    const extended: Record<string, any> = {};

    // Extract params_billions
    const params = parseNumber(model.params_billions);
    if (params !== null) extended.params_billions = params;

    // Extract context_length
    const context = parseNumber(model.context_length);
    if (context !== null) extended.context_length = context;

    // Extract architecture
    if (model.architecture) extended.architecture = model.architecture;

    // Extract quantizations from tags
    const quants = extractQuantizations(
        Array.isArray(model.tags) ? model.tags :
            (typeof model.tags === 'string' ? JSON.parse(model.tags || '[]') : [])
    );
    if (quants.length > 0) extended.quantizations = quants;

    return extended;
}


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

    // V7.1: List pending files in ingest/batches/ (aligned with L1 Harvester V7.1)
    console.log('[Ingest] Listing files in ingest/batches/...');
    const listed = await env.R2_ASSETS.list({
        prefix: 'ingest/batches/',
        limit: 100,
        startAfter: checkpoint.lastId || undefined
    });

    console.log(`[Ingest] R2 list returned: ${listed.objects.length} total objects, truncated: ${listed.truncated}`);

    // V7.1: Filter for .json.gz files (L1 V7.1 uses gzip compression)
    const jsonFiles = listed.objects.filter((obj: any) =>
        obj.key.endsWith('.json.gz') || obj.key.endsWith('.json')
    );

    if (jsonFiles.length === 0) {
        console.log('[Ingest] No pending files in ingest/batches/');
        return { filesProcessed: 0, modelsIngested: 0, messagesQueued: 0 };
    }

    console.log(`[Ingest] Found ${jsonFiles.length} files to process`);

    // V7.1: Reduced batch size for memory safety (Constitution Art 2.4)
    const MAX_FILES_PER_RUN = 20; // Reduced from 100 for memory safety
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

            // Route invalid models to Shadow DB
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
                            last_modified, indexed_at,
                            pipeline_tag, primary_category, tags,
                            source, source_url, link_status,
                            params_billions, context_length, architecture, meta_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).bind(
                        m.id,
                        m.type || 'model',
                        m.name,
                        m.author,
                        m.likes || 0,
                        m.downloads || 0,
                        m.fni_score || 0,
                        m.last_modified || m.last_updated,
                        new Date().toISOString(),
                        m.pipeline_tag,
                        m.primary_category,
                        typeof m.tags === 'string' ? m.tags : JSON.stringify(m.tags || []),
                        m.source || 'huggingface',
                        m.source_url,
                        m.link_status || 'ok',
                        extendedMeta.params_billions || null,
                        extendedMeta.context_length || null,
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

