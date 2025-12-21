/**
 * V7.1 Ingestion Queue Consumer
 * 
 * Processes batches from ingest/batches/ based on manifest.json
 * Reads gzipped batch files, decompresses, and upserts to D1
 * 
 * @module consumers/ingestion
 */

import { Env } from '../config/types';
import { cleanModel, validateModel, routeToShadowDB, ValidationResult } from '../utils/entity-helper';
import { enrichModel } from '../utils/model-enricher';

interface ManifestMessage {
    manifestPath: string;
    batchCount: number;
    totalEntities: number;
    timestamp: string;
}

interface BatchMessage {
    batchPath: string;
    batchIndex: number;
}

/**
 * Decompress gzipped data from R2
 */
async function decompressGzip(data: ArrayBuffer): Promise<string> {
    const ds = new DecompressionStream('gzip');
    const decompressedStream = new Response(data).body!.pipeThrough(ds);
    return await new Response(decompressedStream).text();
}

/**
 * Consume ingestion queue messages
 * Supports two message types:
 * 1. Manifest trigger: reads manifest.json and queues batch messages
 * 2. Batch process: reads individual batch and upserts to D1
 */
export async function consumeIngestionQueue(batch: any, env: Env): Promise<void> {
    console.log(`[V7.1 Ingestion] Processing ${batch.messages.length} messages...`);

    for (const msg of batch.messages) {
        try {
            const body = msg.body as ManifestMessage | BatchMessage;

            // Check kill-switch
            const systemPause = await env.KV?.get('SYSTEM_PAUSE');
            if (systemPause === 'true') {
                console.log('[V7.1 Ingestion] SYSTEM_PAUSE active, retrying later');
                msg.retry();
                continue;
            }

            if ('manifestPath' in body) {
                // Type 1: Manifest trigger - queue individual batch messages
                await processManifest(env, body as ManifestMessage);
            } else if ('batchPath' in body) {
                // Type 2: Individual batch processing
                await processBatch(env, body as BatchMessage);
            }

            msg.ack();
        } catch (err) {
            console.error('[V7.1 Ingestion] Processing failed:', err);
            msg.retry();
        }
    }
}

/**
 * Process manifest and queue batch messages
 */
async function processManifest(env: Env, manifest: ManifestMessage): Promise<void> {
    console.log(`[V7.1] Processing manifest: ${manifest.manifestPath}`);

    const manifestObj = await env.R2_ASSETS.get(manifest.manifestPath);
    if (!manifestObj) {
        console.error(`[V7.1] Manifest not found: ${manifest.manifestPath}`);
        return;
    }

    const manifestData = await manifestObj.json() as {
        version: string;
        batches: string[];
        status: string;
    };

    if (manifestData.status !== 'ready') {
        console.log('[V7.1] Manifest not ready, skipping');
        return;
    }

    console.log(`[V7.1] Found ${manifestData.batches.length} batches to process`);

    // Queue individual batch messages
    const batchMessages = manifestData.batches.map((batchPath, index) => ({
        body: {
            batchPath,
            batchIndex: index
        }
    }));

    await env.INGESTION_QUEUE.sendBatch(batchMessages);
    console.log(`[V7.1] Queued ${batchMessages.length} batch messages`);
}

/**
 * Process individual batch file
 */
async function processBatch(env: Env, batch: BatchMessage): Promise<void> {
    console.log(`[V7.1] Processing batch ${batch.batchIndex}: ${batch.batchPath}`);

    const batchObj = await env.R2_ASSETS.get(batch.batchPath);
    if (!batchObj) {
        console.error(`[V7.1] Batch not found: ${batch.batchPath}`);
        return;
    }

    // Decompress gzipped batch
    const compressedData = await batchObj.arrayBuffer();
    const jsonString = await decompressGzip(compressedData);
    const entities = JSON.parse(jsonString) as any[];

    console.log(`[V7.1] Batch ${batch.batchIndex}: ${entities.length} entities`);

    // Clean and validate
    const validEntities: any[] = [];
    const invalidEntities: { entity: any; validation: ValidationResult }[] = [];

    for (const entity of entities) {
        const cleaned = cleanModel(entity);
        const validation = validateModel(cleaned);

        if (validation.valid) {
            const enriched = enrichModel(cleaned);
            validEntities.push({ ...cleaned, ...enriched });
        } else {
            invalidEntities.push({ entity: cleaned, validation });
        }
    }

    console.log(`[V7.1] Validation: ${validEntities.length} valid, ${invalidEntities.length} invalid`);

    // Route invalid to shadow DB
    for (const { entity, validation } of invalidEntities) {
        await routeToShadowDB(env.DB, entity, validation);
    }

    // Batch upsert valid entities to D1
    const BATCH_SIZE = 50;
    for (let i = 0; i < validEntities.length; i += BATCH_SIZE) {
        const batchEntities = validEntities.slice(i, i + BATCH_SIZE);
        const stmts = batchEntities.map(m =>
            env.DB.prepare(`
                INSERT OR REPLACE INTO entities (
                    id, type, name, author, 
                    likes, downloads, fni_score,
                    last_modified, indexed_at,
                    pipeline_tag, primary_category, tags,
                    source, source_url, link_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                m.tags,
                m.source || 'unknown',
                m.source_url,
                m.link_status || 'ok'
            )
        );

        await env.DB.batch(stmts);
    }

    console.log(`[V7.1] Batch ${batch.batchIndex} complete: ${validEntities.length} entities upserted`);
}

export default { consumeIngestionQueue };
