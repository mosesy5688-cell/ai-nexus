
import { Env } from '../config/types';
import { deriveEntityType } from '../utils/entity-helper';
import { writeToR2 } from '../utils/gzip';
import {
    initHydrationManifest,
    computeEntityHash,
    recordHydrationBatch,
    writeHydrationManifest
} from '../utils/hydration-manifest';

// V1.2: Track batch number across invocations
let currentBatchId = 0;

export async function consumeHydrationQueue(batch: any, env: Env): Promise<void> {
    const schemaHash = 'sha256:' + Date.now().toString(36);
    const contractVersion = 'entity-cache@1.0';

    // V1.2: Initialize manifest on first batch
    const jobId = Date.now().toString();
    if (currentBatchId === 0) {
        initHydrationManifest('ingest/manifest.json', 'complete');
    }
    currentBatchId++;

    // V1.2: Track processed entities for this batch
    const processedEntities: Array<{ id: string; hash: string; path: string }> = [];
    const failedIds: string[] = [];

    const materialize = async (body: any) => {
        const { model, relatedLinks } = body;

        // V10.5: Use model.entity_type if provided, fallback to ID pattern detection
        const entityType = model.entity_type || deriveEntityType(model.id);

        // V10.4: Normalize slug to match cache reader lookup format
        // Format: source--author--name (e.g., replicate--meta--meta-llama-3.1-405b-instruct)
        let slug = model.slug;
        if (!slug) {
            const id = model.id || '';
            const source = model.source || id.split(':')[0] || 'huggingface';
            // Remove source prefix from ID if present
            const idWithoutSource = id.replace(/^[a-z]+:/i, '');
            // Convert to cache format: source--author--name
            const normalizedId = idWithoutSource.replace(/\//g, '--').replace(/:/g, '--');
            slug = `${source}--${normalizedId}`.toLowerCase();
        }

        // V8.0: Extract similar_models from meta_json if computed by L5
        let metaJson = model.meta_json || {};
        if (typeof metaJson === 'string') {
            try { metaJson = JSON.parse(metaJson); } catch { metaJson = {}; }
        }
        const similarModels = metaJson.similar_models || model.similar_models || [];

        const entityCache = {
            contract_version: contractVersion,
            schema_hash: schemaHash,
            entity: {
                ...model,
                entity_type: entityType,
                // V8.0: Ensure similar_models is at entity level for frontend
                similar_models: similarModels,
            },
            computed: {
                fni: model.fni_score ? { score: model.fni_score, deploy_score: model.deploy_score || 0 } : null,
                benchmarks: [],
                relations: { links: relatedLinks, link_count: relatedLinks.length }
            },
            seo: {
                title: `${model.name} by ${model.author || 'Unknown'} | Free AI Tools`,
                description: model.seo_summary || model.description?.slice(0, 160) || `Explore ${model.name}.`
            },
            generated_at: new Date().toISOString(),
            version: 'V8.0'
        };

        // Path determination (Legacy Compat + V6.2 Universal)
        let cachePath: string;
        if (entityType === 'model') {
            cachePath = `cache/models/${slug}.json`;
        } else {
            cachePath = `cache/entities/${entityType}/${slug}.json`;
        }

        // CES V5.1.2 Art 2.4.2: Force Gzip
        await writeToR2(env, cachePath, entityCache);

        // V1.2: Track entity hash for manifest
        const entityHash = computeEntityHash(entityCache);
        return { id: model.id || slug, hash: entityHash, path: cachePath };
    };

    // Parallel processing with retries
    const promises = batch.messages.map(async (msg: any) => {
        try {
            const result = await materialize(msg.body);
            processedEntities.push(result);
            msg.ack();
        } catch (err) {
            console.error('[Queue] Materialization failed:', err);
            failedIds.push(msg.body?.model?.id || 'unknown');
            msg.retry();
        }
    });

    await Promise.all(promises);

    // V1.2: Record this batch in manifest
    recordHydrationBatch(currentBatchId, processedEntities, failedIds);

    // V1.2: Write manifest to R2 periodically (every 10 batches or on completion)
    if (currentBatchId % 10 === 0 || batch.messages.length < 100) {
        await writeHydrationManifest(env, jobId);
    }
}
