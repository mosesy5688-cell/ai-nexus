/**
 * V25.8.2 Shard Packer — Unified NXVF V4.1 Binary VFS
 *
 * Creates fused-shard-NNN.bin files using ShardWriter (NXVF V4.1):
 * - Magic "NXVF"(4B) | Version(1B) | SlotID(2B) | OffsetTableOffset(4B) |
 *   EntityCount(4B) | Checksum(4B) | EmbeddingOffset(4B) | EmbeddingCount(4B) | EmbeddingDim(2B)
 * - Zstd-compressed + AES-256-CTR encrypted payloads
 * - Trailing O(1) Offset Table for instant byte-seek
 *
 * Routing: computeShardSlot(UMID) maps 4096 logical slots -> physical shards
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { autoDecompress } from './lib/zstd-helper.js';
import { generateUMID } from './lib/umid-generator.js';
import { initRustBridge, computeShardSlotFFI, buildEnrichmentManifestFFI, validateFusionContentFFI } from './lib/rust-bridge.js';
import { ShardWriter } from './lib/shard-writer.js';
import { createR2Client, streamToR2, downloadFromR2, fetchAllR2ETags } from './lib/r2-helpers.js';
import { ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const SHARD_SOFT_LIMIT = 4 * 1024 * 1024;  // 4MB soft (optimized for VFS-mmap)
const TOTAL_SLOTS = 4096;
const OUTPUT_DIR = './output/data/v4-shards';
const PULSE_INTERVAL = 5000;
const CURSOR_FILE = './packer-cursor.json';
const R2_CURSOR_KEY = 'state/packer-cursor.json';

/**
 * Pack entities into NXVF V4.1 binary shards
 */
export async function packV4Shards() {
    console.log('[V4-PACKER] Starting NXVF V4.1 Shard Packing (V25.8.2 Unified)...');

    // Initialize Rust FFI (xxhash64 routing)
    const rustStatus = initRustBridge();
    console.log(`[V4-PACKER] Rust: ${rustStatus.mode}`);

    // R2 client for pulse sync
    const r2 = createR2Client();
    const r2Bucket = process.env.R2_BUCKET || 'ai-nexus-assets';

    // Check for existing cursor (resume support)
    let resumeFromEntity = 0;
    const cursor = r2 ? await downloadFromR2(r2, r2Bucket, R2_CURSOR_KEY) : null;
    if (cursor?.processedCount) {
        resumeFromEntity = cursor.processedCount;
        console.log(`[V4-PACKER] Resuming from cursor: ${resumeFromEntity} entities`);
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Load UMID mapping (V55.9: support both .zst and legacy .gz)
    let umidMapping = {};
    try {
        let raw;
        try { raw = await fs.readFile('data/umid-mapping.json.zst'); }
        catch { raw = await fs.readFile('data/umid-mapping.json.gz'); }
        umidMapping = JSON.parse((await autoDecompress(raw)).toString());
        console.log(`[V4-PACKER] Loaded ${Object.keys(umidMapping).length} UMID mappings`);
    } catch {
        console.error('[V4-PACKER] FATAL: umid-mapping.json.{zst,gz} not found. Run --phase=umid-stamping first.');
        process.exit(1);
    }

    // Density check — reject dehydrated registries (< 100MB compressed)
    const DENSITY_FLOOR = 100 * 1024 * 1024;
    const registryPath = process.env.REGISTRY_MONOLITH || './cache/global-registry.json.gz';
    try {
        const stat = await fs.stat(registryPath);
        if (stat.size < DENSITY_FLOOR) {
            console.error(`[V4-PACKER] DENSITY ALERT: ${registryPath} is ${(stat.size / 1024 / 1024).toFixed(1)}MB (floor: 100MB)`);
            console.error('[V4-PACKER] Dehydrated version detected. Aborting to prevent data loss.');
            process.exit(1);
        }
        console.log(`[V4-PACKER] Density OK: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    } catch { /* File may not exist if using shard-based input */ }

    // Multi-source input — fused dir + registry shards
    const fusedDir = process.env.FUSED_DIR || './output/cache/fused';
    const registryDir = process.env.REGISTRY_DIR || './cache/registry';
    const allSourceFiles = [];
    for (const dir of [fusedDir, registryDir]) {
        const files = (await fs.readdir(dir).catch(() => []))
            .filter(f => f.endsWith('.json') || f.endsWith('.json.gz'));
        for (const f of files) allSourceFiles.push({ dir, file: f });
    }

    if (allSourceFiles.length === 0) {
        console.error(`[V4-PACKER] No entities found in ${fusedDir} or ${registryDir}`);
        process.exit(1);
    }
    console.log(`[V4-PACKER] Sources: ${allSourceFiles.length} files`);

    // V25.8.3 Fusion Sweep — build enrichment manifest via Rust FFI (Spec §3.2)
    let enrichmentManifest = new Map();
    if (r2) {
        console.log('[V4-PACKER] Fusion Sweep: scanning R2 enrichment/fulltext/...');
        const etags = await fetchAllR2ETags(r2, r2Bucket, ['enrichment/fulltext/']);
        enrichmentManifest = buildEnrichmentManifestFFI([...etags.keys()]);
        console.log(`[V4-PACKER] Fusion Sweep: ${enrichmentManifest.size} enriched papers found`);
    }

    // Route entities to logical slots
    const slots = new Map();
    let entityIndex = 0;

    for (const { dir, file } of allSourceFiles) {
        const raw = await fs.readFile(path.join(dir, file));
        const parsed = JSON.parse((await autoDecompress(raw)).toString('utf-8'));
        const entities = parsed.entities || (parsed.id ? [parsed] : [parsed]);

        for (const entity of entities) {
            const id = entity.id || entity.slug;
            if (!id) continue;
            entityIndex++;

            if (entityIndex <= resumeFromEntity) continue;

            const umid = umidMapping[id] || generateUMID(id);
            const slotId = computeShardSlotFFI(umid, TOTAL_SLOTS);

            // V25.8.3 Fusion: inject enriched fulltext via Rust validation (Spec §3.2)
            let bodyContent = entity.readme || entity.html_readme || entity.body_content || '';
            let hasFulltext = entity.has_fulltext || false;
            if (entity.type === 'paper' && enrichmentManifest.has(umid)) {
                try {
                    const { Body } = await r2.send(new GetObjectCommand({
                        Bucket: r2Bucket, Key: enrichmentManifest.get(umid)
                    }));
                    const chunks = []; for await (const c of Body) chunks.push(c);
                    const fulltext = (await autoDecompress(Buffer.concat(chunks))).toString('utf-8');
                    // Rust FFI validates quality + prevents downgrade
                    const fusion = validateFusionContentFFI(fulltext, bodyContent);
                    bodyContent = fusion.text;
                    hasFulltext = fusion.hasFulltext;
                } catch { /* non-fatal: keep original body_content */ }
            }

            const payload = Buffer.from(JSON.stringify({
                umid,
                readme: bodyContent,
                has_fulltext: hasFulltext,
                mesh_profile: entity.mesh_profile || { relations: [] },
                benchmarks: entity.benchmarks || [],
                paper_abstract: entity.paper_abstract || '',
                changelog: entity.changelog || ''
            }), 'utf8');

            if (!slots.has(slotId)) slots.set(slotId, []);
            slots.get(slotId).push({ umid, payload });

            // Pulse Sync — checkpoint every 5000 entities
            if (entityIndex % PULSE_INTERVAL === 0) {
                const cursorData = { processedCount: entityIndex, lastId: id, timestamp: new Date().toISOString() };
                if (r2) await streamToR2(r2, r2Bucket, R2_CURSOR_KEY, cursorData);
                await fs.writeFile(CURSOR_FILE, JSON.stringify(cursorData));
                console.log(`  [PULSE] Checkpoint at entity ${entityIndex}`);
            }
        }
    }

    console.log(`[V4-PACKER] Routed entities to ${slots.size} logical slots (of ${TOTAL_SLOTS})`);

    // Initialize ShardWriter (NXVF V4.1 — Zstd + AES-CTR handled internally)
    const writer = new ShardWriter(OUTPUT_DIR);
    await writer.init();
    writer.open();

    const sortedSlots = [...slots.entries()].sort((a, b) => a[0] - b[0]);
    const manifest = {};
    let totalEntities = 0;

    for (const [slotId, entities] of sortedSlots) {
        const slotPayloadSize = entities.reduce((sum, e) => sum + e.payload.length, 0);

        // Split shard if exceeding soft limit
        if (writer.shardSize > 0 && writer.wouldExceed(slotPayloadSize, SHARD_SOFT_LIMIT)) {
            manifest[writer.currentName] = { slotRange: slotId, entities: writer.entityOffsets.length, size: writer.shardSize };
            writer.nextShard();
        }

        for (const entity of entities) {
            writer.writeEntity(entity.payload);
            totalEntities++;
        }
    }

    // Finalize last shard
    if (writer.entityOffsets.length > 0) {
        manifest[writer.currentName] = { entities: writer.entityOffsets.length, size: writer.shardSize };
    }
    writer.finalize();

    const totalShards = writer.shardId + 1;

    // Write manifest
    await fs.writeFile(
        path.join(OUTPUT_DIR, 'v4-manifest.json'),
        JSON.stringify({ version: '4.1', format: 'NXVF', totalShards, slots: TOTAL_SLOTS, manifest }, null, 2)
    );

    console.log(`[V4-PACKER] Complete: ${totalShards} shards (NXVF V4.1), ${totalEntities} entities, ${slots.size}/${TOTAL_SLOTS} slots`);
}

// CLI entry point
if (process.argv[1]?.endsWith('shard-packer-v4.js')) {
    packV4Shards().catch(err => {
        console.error('[V4-PACKER] Fatal:', err);
        process.exit(1);
    });
}
