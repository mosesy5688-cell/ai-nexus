/**
 * Registry Bootstrap V16.2
 * 
 * Reconstructs the 140k-entity global-registry.json from R2 filenames.
 * 
 * Logic:
 * 1. Sweep R2 bucket 'cache/entities/'
 * 2. Parse filenames into {id, type}
 * 3. Group by normalized ID
 * 4. Generate 'hollow' archived entities for SEO safety
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import { normalizeId } from './relation-extractors.js';
import { saveGlobalRegistry } from './cache-manager.js';
import dotenv from 'dotenv';

dotenv.config();

const R2_BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';
const ENTITIES_PREFIX = 'cache/entities/';

const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    }
});

async function bootstrap() {
    console.log('[BOOTSTRAP] Starting state reconstruction via S3 SDK...');

    const registry = new Map();
    let continuationToken = null;
    let pageCount = 0;

    try {
        do {
            pageCount++;
            const command = new ListObjectsV2Command({
                Bucket: R2_BUCKET,
                Prefix: ENTITIES_PREFIX,
                ContinuationToken: continuationToken,
                MaxKeys: 1000
            });

            const response = await s3.send(command);
            const contents = response.Contents || [];

            for (const obj of contents) {
                // Path: cache/entities/{type}/{slug}.json
                const parts = obj.Key.split('/');
                if (parts.length < 4) continue;

                const type = parts[2];
                let rawName = parts[3].replace('.json', '');

                // V16.2.1 FIX: Skip metadata files
                if (rawName.endsWith('.meta')) continue;

                // V16.2.1 FIX: Strip historical version suffixes (.v-1, .v-2, etc.)
                const baseName = rawName.split('.v-')[0];

                // Re-normalize ID from base filename
                const id = normalizeId(baseName, type);
                if (!id) continue;

                const existing = registry.get(id);
                if (!existing || new Date(obj.LastModified) > new Date(existing._last_seen)) {
                    registry.set(id, {
                        id,
                        type,
                        status: 'archived',
                        _last_seen: obj.LastModified,
                        _bootstrapped: true
                    });
                }
            }

            continuationToken = response.NextContinuationToken;

            if (pageCount % 10 === 0) {
                console.log(`  [SDK] Page ${pageCount}: Found ${registry.size} entities...`);
            }

        } while (continuationToken);

        const entities = Array.from(registry.values());
        console.log(`\n✅ [BOOTSTRAP] Reconstruction complete!`);
        console.log(`   Total Unique Entities: ${entities.length}`);

        await saveGlobalRegistry({
            entities,
            lastUpdated: new Date().toISOString(),
            count: entities.length,
            bootstrap: true
        });

        console.log(`   Saved to global-registry.json`);
    } catch (err) {
        console.error('[BOOTSTRAP] Fatal Error:', err.message);
        process.exit(1);
    }
}

bootstrap().catch(console.error);
