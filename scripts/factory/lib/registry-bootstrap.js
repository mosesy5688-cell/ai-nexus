/**
 * V25.8 Registry Bootstrap - UMID Stamping & Vault Push
 *
 * Phase 1 Migration: Assigns permanent UMIDs to all 400k+ entities
 * and prepares the R2 Vault for V4.0 shard packing.
 *
 * Phases:
 *   --phase=umid-stamping  : Stamp UMIDs on all entities, output mapping
 *   --phase=vault-push     : Upload raw baseline to R2 /vault/legacy/
 *   --phase=initial-pack   : Execute V4.0 shard packer (delegates to shard-packer-v4.js)
 */

import { S3Client, ListObjectsV2Command, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { generateUMID, generateCanonicalUrl, generateCitation } from './umid-generator.js';
import { loadGlobalRegistry } from './cache-manager.js';
import { createR2Client } from './r2-helpers.js';
import { initRustBridge } from './rust-bridge.js';
import { initShardCrypto } from './shard-crypto.js';
import dotenv from 'dotenv';

dotenv.config();

const gzip = promisify(zlib.gzip);
const R2_BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';
const LOCK_KEY = 'vault/lock.json';

const args = process.argv.slice(2);
const phaseArg = args.find(a => a.startsWith('--phase='))?.split('=')[1];

async function acquireLock(s3) {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: LOCK_KEY }));
        console.error('[BOOTSTRAP] R2 lock exists. Another bootstrap may be running. Aborting.');
        process.exit(1);
    } catch {
        // Lock doesn't exist, acquire it
        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET, Key: LOCK_KEY,
            Body: JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
            ContentType: 'application/json'
        }));
        console.log('[BOOTSTRAP] R2 lock acquired.');
    }
}

async function releaseLock(s3) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: LOCK_KEY }));
    console.log('[BOOTSTRAP] R2 lock released.');
}

// ── Phase A: UMID Stamping ──────────────────────────────
async function phaseUmidStamping() {
    console.log('[BOOTSTRAP] Phase A: UMID Stamping (V25.8)...');

    if (!process.env.UMID_SALT) {
        console.error('[BOOTSTRAP] FATAL: UMID_SALT environment variable is required.');
        process.exit(1);
    }

    const registry = await loadGlobalRegistry({ slim: false });
    const entities = registry.entities || registry;

    if (!Array.isArray(entities) || entities.length === 0) {
        console.error('[BOOTSTRAP] FATAL: No entities found in global registry.');
        process.exit(1);
    }

    console.log(`[BOOTSTRAP] Processing ${entities.length} entities...`);

    const mapping = {};
    let stamped = 0;

    for (const entity of entities) {
        const id = entity.id || entity.slug;
        if (!id) continue;

        const umid = generateUMID(id);
        entity.umid = umid;
        entity.canonical_url = generateCanonicalUrl(entity);
        entity.citation = generateCitation(entity);
        mapping[id] = umid;
        stamped++;

        if (stamped % 50000 === 0) {
            console.log(`  [STAMP] ${stamped} entities processed...`);
        }
    }

    // Output mapping file
    const mappingPath = 'data/umid-mapping.json.gz';
    await fs.mkdir('data', { recursive: true });
    const compressed = await gzip(Buffer.from(JSON.stringify(mapping)));
    await fs.writeFile(mappingPath, compressed);

    console.log(`[BOOTSTRAP] Phase A complete.`);
    console.log(`  Stamped: ${stamped} entities`);
    console.log(`  Mapping: ${mappingPath} (${(compressed.length / 1024 / 1024).toFixed(2)} MB)`);

    return { entities, mapping };
}

// ── Phase B: Vault Push ─────────────────────────────────
async function phaseVaultPush() {
    console.log('[BOOTSTRAP] Phase B: R2 Vault Push...');

    const s3 = createR2Client();
    await acquireLock(s3);

    try {
        // Upload umid-mapping.json.gz to R2
        const mappingPath = 'data/umid-mapping.json.gz';
        const mappingData = await fs.readFile(mappingPath);

        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: 'vault/bootstrap/umid-mapping.json.gz',
            Body: mappingData,
            ContentType: 'application/gzip'
        }));
        console.log('  Uploaded: vault/bootstrap/umid-mapping.json.gz');

        // Upload raw registry shards to /vault/legacy/
        const registryDir = 'cache/registry';
        try {
            const shards = await fs.readdir(registryDir);
            let uploaded = 0;
            for (const shard of shards) {
                if (!shard.endsWith('.json.gz')) continue;
                const data = await fs.readFile(path.join(registryDir, shard));
                await s3.send(new PutObjectCommand({
                    Bucket: R2_BUCKET,
                    Key: `vault/legacy/registry/${shard}`,
                    Body: data,
                    ContentType: 'application/gzip'
                }));
                uploaded++;
            }
            console.log(`  Uploaded: ${uploaded} registry shards to vault/legacy/`);
        } catch {
            console.warn('  No registry shards found in cache/registry/');
        }

        // Upload monolith backup
        try {
            const monolith = await fs.readFile('cache/global-registry.json.gz');
            await s3.send(new PutObjectCommand({
                Bucket: R2_BUCKET,
                Key: 'vault/legacy/global-registry.json.gz',
                Body: monolith,
                ContentType: 'application/gzip'
            }));
            console.log('  Uploaded: vault/legacy/global-registry.json.gz');
        } catch {
            console.warn('  No global-registry.json.gz found');
        }

        console.log('[BOOTSTRAP] Phase B complete. Raw baseline preserved on R2.');
    } finally {
        await releaseLock(s3);
    }
}

// ── Main ────────────────────────────────────────────────
async function main() {
    if (!phaseArg) {
        console.log('[BOOTSTRAP] Running full V25.8 bootstrap pipeline...');
        await phaseUmidStamping();
        await phaseVaultPush();
        console.log('[BOOTSTRAP] Full bootstrap complete.');
        return;
    }

    switch (phaseArg) {
        case 'umid-stamping': await phaseUmidStamping(); break;
        case 'vault-push': await phaseVaultPush(); break;
        case 'initial-pack':
            console.log('[BOOTSTRAP] Phase C: Delegating to shard-packer-v4.js...');
            // V25.8: Initialize Rust FFI + AES-CTR before packing
            const rustInfo = initRustBridge();
            const cryptoReady = initShardCrypto();
            console.log(`[BOOTSTRAP] Rust: ${rustInfo.mode} | Crypto: ${cryptoReady ? 'active' : 'disabled'}`);
            const { packV4Shards } = await import('../shard-packer-v4.js');
            await packV4Shards();
            break;
        default:
            console.error(`Unknown phase: ${phaseArg}`);
            process.exit(1);
    }
}

main().catch(err => {
    console.error('[BOOTSTRAP] Fatal Error:', err);
    process.exit(1);
});
