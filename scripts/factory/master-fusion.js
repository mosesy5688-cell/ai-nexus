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
const TOTAL_SHARDS = 20;

async function main() {
    console.log('[FUSION] 🧪 Commencing Master Fusion (Compressed Shard Logic)...');

    let fusedCount = 0;
    let totalEntitiesFound = 0;

    for (let i = 0; i < TOTAL_SHARDS; i++) {
        const shardPath = path.join(ARTIFACT_DIR, `shard-${i}.json.gz`);

        try {
            console.log(`[FUSION] 📦 Processing Shard ${i}...`);
            const compressed = await fs.readFile(shardPath);
            const shardData = JSON.parse(zlib.gunzipSync(compressed));
            const entities = shardData.entities || [];

            totalEntitiesFound += entities.length;

            for (const entityData of entities) {
                if (!entityData.success) continue;
                const id = entityData.id;
                if (!id) continue;

                // Load mesh profile if exists (V16.11: Handle potential Gzip buffer)
                const meshData = await fs.readFile(path.join(MESH_DIR, `${id}.json`))
                    .then(buf => {
                        try {
                            // Check for Gzip magic number (1f 8b)
                            if (buf[0] === 0x1f && buf[1] === 0x8b) {
                                return JSON.parse(zlib.gunzipSync(buf));
                            }
                            return JSON.parse(buf);
                        } catch (e) { return null; }
                    }).catch(() => null);

                // Perform Deep Fusion
                const fusedEntity = {
                    ...entityData.enriched,
                    html_readme: entityData.html || '',
                    mesh_profile: meshData || { relations: [] },
                    _fused_at: new Date().toISOString(),
                    _version: '16.11.0-master-fusion'
                };

                // Save to ultimate fusion storage (with pre-compression logic in smartWriter)
                const targetKey = `fused/${id}.json`;
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
