/**
 * Master Fusion Orchestrator V16.11.0
 * Architecture: Monolithic Shard Iteration (Gzip Enabled)
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { smartWriteWithVersioning } from './lib/smart-writer.js';

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || './artifacts';
const MESH_DIR = path.join(CACHE_DIR, 'mesh/profiles');
async function main() {
    console.log('[FUSION] 🧪 Commencing Master Fusion (Compressed Shard Logic)...');

    let fusedCount = 0;
    let totalEntitiesFound = 0;

    const files = await fs.readdir(ARTIFACT_DIR).catch(() => []);
    const shardFiles = files.filter(f => f.startsWith('part-') && f.endsWith('.json.gz'))
        .sort((a, b) => {
            const na = parseInt(a.match(/\d+/)[0]);
            const nb = parseInt(b.match(/\d+/)[0]);
            return na - nb;
        });

    console.log(`[FUSION] Found ${shardFiles.length} shards in ${ARTIFACT_DIR}`);

    for (let i = 0; i < shardFiles.length; i++) {
        const file = shardFiles[i];
        const shardPath = path.join(ARTIFACT_DIR, file);

        try {
            console.log(`[FUSION] 📦 Processing Shard ${i} (${file})...`);
            const compressed = await fs.readFile(shardPath);
            const shardData = JSON.parse(zlib.gunzipSync(compressed));
            const entities = shardData.entities || [];

            totalEntitiesFound += entities.length;

            for (const entityData of entities) {
                const id = entityData.id || entityData.slug;
                if (!id) continue;

                // Load mesh profile if exists (V16.6: Try .gz first, then fallback to .json)
                const meshPath = path.join(MESH_DIR, `${id}.json.gz`);
                const meshFallback = path.join(MESH_DIR, `${id}.json`);

                const meshData = await fs.readFile(meshPath)
                    .catch(() => fs.readFile(meshFallback))
                    .then(buf => {
                        try {
                            // Check for Gzip magic number (1f 8b)
                            if (buf[0] === 0x1f && buf[1] === 0x8b) {
                                return JSON.parse(zlib.gunzipSync(buf));
                            }
                            return JSON.parse(buf);
                        } catch (e) { return null; }
                    }).catch(() => null);

                // Load existing fused data to preserve timestamp if unchanged (V19.3: Gzip Aware)
                const targetKey = `fused/${id}.json`;
                const existingPath = path.join(CACHE_DIR, `${targetKey}.gz`);
                const existingFallback = path.join(CACHE_DIR, targetKey);

                const existingData = await fs.readFile(existingPath)
                    .catch(() => fs.readFile(existingFallback))
                    .then(buf => {
                        try {
                            if (buf[0] === 0x1f && buf[1] === 0x8b) {
                                return JSON.parse(zlib.gunzipSync(buf));
                            }
                            return JSON.parse(buf);
                        } catch (e) { return null; }
                    }).catch(() => null);

                // Perform Deep Fusion
                const baseData = entityData.enriched || entityData;

                // V19.2 Stability Optimization: Only update timestamp if content actually changes
                let _fused_at = new Date().toISOString();
                if (existingData) {
                    const hasDataChanged =
                        JSON.stringify(existingData.mesh_profile) !== JSON.stringify(meshData || { relations: [] }) ||
                        existingData.html_readme !== (entityData.html || baseData.html_readme || '') ||
                        existingData._fusion_status !== (entityData.success ? 'refined' : 'raw');

                    if (!hasDataChanged) {
                        _fused_at = existingData._fused_at;
                    }
                }

                const fusedEntity = {
                    ...baseData,
                    id: id,
                    html_readme: entityData.html || baseData.html_readme || '',
                    mesh_profile: meshData || { relations: [] },
                    _fused_at,
                    _version: '16.11.1-stable-fusion',
                    _fusion_status: entityData.success ? 'refined' : 'raw'
                };

                // Save to ultimate fusion storage (with pre-compression logic in smartWriter)
                await smartWriteWithVersioning(targetKey, fusedEntity, CACHE_DIR, { compress: true });

                fusedCount++;
                if (fusedCount % 5000 === 0) console.log(`[FUSION] Fused ${fusedCount} nodes...`);
            }
        } catch (e) {
            console.error(`[FUSION] ❌ Failed to process Shard ${i}:`, e.message);
        }
    }

    console.log(`[FUSION] ✅ Finalized ${fusedCount}/${totalEntitiesFound} Universal Refined Entities.`);
}

main().catch(console.error);
