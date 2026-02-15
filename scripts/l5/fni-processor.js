/**
 * L5 FNI Processor - Batch & Manifest Logic
 * Extracted from fni-compute.js for CES compliance (Art 5.1)
 */
import fs from 'fs';
import path from 'path';
import * as manifest from './manifest-utils.js';

const BATCH_SIZE = 50000;

export async function processBatches(entities, outputDir, calculateFNIFn) {
    const mf = manifest.loadManifest();
    const resumeFrom = manifest.getResumePoint(mf);
    if (resumeFrom > 0) console.log(`🔄 Resuming from batch ${resumeFrom}`);

    const results = [];
    const totalBatches = Math.ceil(entities.length / BATCH_SIZE);

    for (let i = 0; i < entities.length; i += BATCH_SIZE) {
        const batchNum = Math.floor(i / BATCH_SIZE);
        if (manifest.isBatchComplete(mf, batchNum)) continue;

        const batch = entities.slice(i, i + BATCH_SIZE);
        console.log(`🔄 Processing batch ${batchNum + 1}/${totalBatches}...`);

        const batchResults = batch.map(entity => {
            const { fni_score, fni_breakdown } = calculateFNIFn(entity);
            return {
                id: entity.id, type: entity.type || entity.entity_type,
                name: entity.name, fni_score, fni_breakdown,
                source: entity.source, primary_category: entity.primary_category
            };
        });

        results.push(...batchResults);
        const batchFile = path.join(outputDir, `fni_batch_${batchNum}.json`);
        fs.writeFileSync(batchFile, JSON.stringify(batchResults, null, 2));

        manifest.recordBatch(mf, {
            index: batchNum, key: `computed/fni_batch_${batchNum}.json`,
            entitiesCount: batchResults.length, filePath: batchFile
        });
    }

    manifest.completeManifest(mf);
    return { results, totalBatches, manifestSummary: manifest.getSummary(mf) };
}
