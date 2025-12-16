
import { Env } from '../config/types';
import { cleanModel, validateModel, routeToShadowDB, ValidationResult } from '../utils/entity-helper';

export async function runIngestionStep(env: Env, checkpoint: any): Promise<{ filesProcessed: number; modelsIngested: number }> {
    console.log('[Ingest] Starting ingestion...');
    console.log(`[L1] Resume from checkpoint: lastId=${checkpoint.lastId}`);

    // List pending files in raw-data/
    console.log('[Ingest] Listing files in raw-data/...');
    const listed = await env.R2_ASSETS.list({
        prefix: 'raw-data/',
        limit: 100,
        startAfter: checkpoint.lastId || undefined  // L1: Resume from lastId
    });

    console.log(`[Ingest] R2 list returned: ${listed.objects.length} total objects, truncated: ${listed.truncated}`);

    const jsonFiles = listed.objects.filter(obj => obj.key.endsWith('.json'));

    if (jsonFiles.length === 0) {
        console.log('[Ingest] No pending files in raw-data/');
        return { filesProcessed: 0, modelsIngested: 0 };
    }

    console.log(`[Ingest] Found ${jsonFiles.length} files to process`);

    // V4.1 HUNGRY MODE: Process up to 20 files per run
    const MAX_FILES_PER_RUN = 20;
    let totalModels = 0;
    let filesProcessed = 0;

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

            // Clean and prepare models
            const cleanedModels = models.map(m => cleanModel(m));

            // L2 VALIDATION: Separate valid from invalid models (Art.Shadow)
            const validModels: any[] = [];
            const invalidModels: { model: any; validation: ValidationResult }[] = [];

            for (const m of cleanedModels) {
                const validation = validateModel(m);
                if (validation.valid) {
                    validModels.push(m);
                } else {
                    invalidModels.push({ model: m, validation });
                }
            }

            console.log(`[Ingest] Validation: ${validModels.length} valid, ${invalidModels.length} invalid`);

            // Route invalid models to Shadow DB
            for (const { model, validation } of invalidModels) {
                await routeToShadowDB(env.DB, model, validation);
            }

            // Write valid models to D1 in batches
            for (let i = 0; i < validModels.length; i += 50) {
                const batch = validModels.slice(i, i + 50);
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
}
