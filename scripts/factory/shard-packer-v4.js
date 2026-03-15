/**
 * V25.8 Shard Packer V4.0 - Binary VFS with Headers & Offset Tables
 *
 * Creates fused-shard-NNN.bin files with:
 * - Magic(4B) | Version(1B) | SlotID(2B) | OffsetTableOffset(4B) | EntityCount(4B) | Checksum(4B)
 * - Entity payloads (README, markdown, adjacency)
 * - Trailing O(1) Offset Table for instant byte-seek
 *
 * Routing: computeShardSlot(UMID) maps 4096 logical slots -> ~2000 physical shards
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { generateUMID } from './lib/umid-generator.js';
import { initRustBridge, computeShardSlotFFI } from './lib/rust-bridge.js';
import { initShardCrypto, encryptPayload } from './lib/shard-crypto.js';
import { createR2Client, streamToR2, downloadFromR2 } from './lib/r2-helpers.js';

const SHARD_SOFT_LIMIT = 4 * 1024 * 1024;  // V25.8: 4MB soft (was 8MB, optimized for VFS-mmap)
const SHARD_HARD_CAP = 6 * 1024 * 1024;    // 6MB hard
const HEADER_SIZE = 19; // Magic(4) + Version(1) + SlotID(2) + OffsetTableOff(4) + EntityCount(4) + Checksum(4)
const TOTAL_SLOTS = 4096;
const OUTPUT_DIR = './output/data/v4-shards';
const PULSE_INTERVAL = 5000; // V25.8: Checkpoint every 5000 entities
const CURSOR_FILE = './packer-cursor.json';
const R2_CURSOR_KEY = 'state/packer-cursor.json';

/**
 * Build V4.0 shard header
 */
function buildHeader(slotId, entityCount, offsetTableOffset) {
    const buf = Buffer.alloc(HEADER_SIZE);
    buf.write('NXS4', 0, 4, 'ascii');  // Magic: Nexus Shard V4
    buf.writeUInt8(4, 4);               // Version
    buf.writeUInt16LE(slotId, 5);        // Slot ID
    buf.writeUInt32LE(offsetTableOffset, 7);  // Offset table position
    buf.writeUInt32LE(entityCount, 11);  // Entity count
    // Checksum filled after full shard is written (bytes 15-18)
    return buf;
}

/**
 * Build trailing offset table for O(1) byte-seek
 * Each entry: UMID_hash(4B) + Offset(4B) + Size(4B) = 12 bytes per entity
 */
function buildOffsetTable(entries) {
    const ENTRY_SIZE = 12;
    const buf = Buffer.alloc(entries.length * ENTRY_SIZE);
    for (let i = 0; i < entries.length; i++) {
        const off = i * ENTRY_SIZE;
        buf.writeUInt32LE(parseInt(entries[i].umid.substring(0, 8), 16) >>> 0, off);
        buf.writeUInt32LE(entries[i].offset, off + 4);
        buf.writeUInt32LE(entries[i].size, off + 8);
    }
    return buf;
}

/**
 * Pack entities into V4.0 binary shards
 */
export async function packV4Shards() {
    console.log('[V4-PACKER] Starting V4.0 Shard Packing (V25.8 Sovereign)...');

    // V25.8: Initialize Rust FFI + AES-256-CTR encryption
    const rustStatus = initRustBridge();
    const cryptoEnabled = initShardCrypto();
    console.log(`[V4-PACKER] Rust: ${rustStatus.mode} | Crypto: ${cryptoEnabled ? 'AES-256-CTR' : 'disabled'}`);

    // V25.8: R2 client for pulse sync
    const r2 = createR2Client();
    const r2Bucket = process.env.R2_BUCKET || 'ai-nexus-assets';

    // V25.8: Check for existing cursor (resume support)
    let resumeFromEntity = 0;
    const cursor = r2 ? await downloadFromR2(r2, r2Bucket, R2_CURSOR_KEY) : null;
    if (cursor?.processedCount) {
        resumeFromEntity = cursor.processedCount;
        console.log(`[V4-PACKER] Resuming from cursor: ${resumeFromEntity} entities`);
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Load UMID mapping
    let umidMapping = {};
    try {
        const raw = await fs.readFile('data/umid-mapping.json.gz');
        umidMapping = JSON.parse(zlib.gunzipSync(raw).toString());
        console.log(`[V4-PACKER] Loaded ${Object.keys(umidMapping).length} UMID mappings`);
    } catch {
        console.error('[V4-PACKER] FATAL: umid-mapping.json.gz not found. Run --phase=umid-stamping first.');
        process.exit(1);
    }

    // V25.8: Density check — reject dehydrated registries (< 100MB compressed)
    const DENSITY_FLOOR = 100 * 1024 * 1024; // 100MB minimum for full-density archive
    const registryPath = process.env.REGISTRY_MONOLITH || './cache/global-registry.json.gz';
    try {
        const stat = await fs.stat(registryPath);
        if (stat.size < DENSITY_FLOOR) {
            console.error(`[V4-PACKER] DENSITY ALERT: ${registryPath} is ${(stat.size / 1024 / 1024).toFixed(1)}MB (floor: 100MB)`);
            console.error('[V4-PACKER] This appears to be a dehydrated version. Aborting to prevent data loss.');
            process.exit(1);
        }
        console.log(`[V4-PACKER] Density OK: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    } catch { /* File may not exist if using shard-based input */ }

    // V25.8 §1: Multi-source input — fused dir + registry shards
    const fusedDir = process.env.FUSED_DIR || './output/cache/fused';
    const registryDir = process.env.REGISTRY_DIR || './cache/registry';
    const sourceDirs = [fusedDir, registryDir];
    const allSourceFiles = [];
    for (const dir of sourceDirs) {
        const files = (await fs.readdir(dir).catch(() => []))
            .filter(f => f.endsWith('.json') || f.endsWith('.json.gz'));
        for (const f of files) allSourceFiles.push({ dir, file: f });
    }

    if (allSourceFiles.length === 0) {
        console.error(`[V4-PACKER] No entities found in ${sourceDirs.join(' or ')}`);
        process.exit(1);
    }
    console.log(`[V4-PACKER] Sources: ${allSourceFiles.length} files`);

    // Route entities to logical slots
    const slots = new Map(); // slotId -> [{ umid, payload }]
    let entityIndex = 0;

    for (const { dir, file } of allSourceFiles) {
        const raw = await fs.readFile(path.join(dir, file));
        const parsed = file.endsWith('.gz') ? JSON.parse(zlib.gunzipSync(raw)) : JSON.parse(raw);
        const entities = parsed.entities || (parsed.id ? [parsed] : [parsed]);

        for (const entity of entities) {
            const id = entity.id || entity.slug;
            if (!id) continue;
            entityIndex++;

            // V25.8: Skip already-processed entities on resume
            if (entityIndex <= resumeFromEntity) continue;

            const umid = umidMapping[id] || generateUMID(id);
            // V25.8: xxhash64 routing via Rust FFI (was JS charCodeAt approximation)
            const slotId = computeShardSlotFFI(umid, TOTAL_SLOTS);

            let payload = Buffer.from(JSON.stringify({
                umid,
                readme: entity.readme || entity.html_readme || entity.body_content || '',
                mesh_profile: entity.mesh_profile || { relations: [] },
                benchmarks: entity.benchmarks || [],
                paper_abstract: entity.paper_abstract || '',
                changelog: entity.changelog || ''
            }), 'utf8');

            // V25.8 §1.1: Encryption deferred to flush phase (needs final shardName + byte offset for IV)
            if (!slots.has(slotId)) slots.set(slotId, []);
            slots.get(slotId).push({ umid, payload });

            // V25.8 §2.3: Pulse Sync — checkpoint every 5000 entities
            if (entityIndex % PULSE_INTERVAL === 0) {
                const cursorData = { processedCount: entityIndex, lastId: id, timestamp: new Date().toISOString() };
                if (r2) await streamToR2(r2, r2Bucket, R2_CURSOR_KEY, cursorData);
                await fs.writeFile(CURSOR_FILE, JSON.stringify(cursorData));
                console.log(`  [PULSE] Checkpoint at entity ${entityIndex}`);
            }
        }
    }

    console.log(`[V4-PACKER] Routed entities to ${slots.size} logical slots (of ${TOTAL_SLOTS})`);

    // Pack slots into physical shards (merge small slots)
    let shardId = 0, shardSize = 0;
    let currentEntries = [], currentPayloads = [];
    let currentSlotId = 0, payloadOffset = 0; // V25.8 §2: track offset incrementally (avoid O(n²) reduce)
    const manifest = {};

    const flushShard = async () => {
        if (currentEntries.length === 0) return;

        const offsetTable = buildOffsetTable(currentEntries);
        const payloadBuf = Buffer.concat(currentPayloads);
        const offsetTableOffset = HEADER_SIZE + payloadBuf.length;
        const header = buildHeader(currentSlotId, currentEntries.length, offsetTableOffset);
        const fullShard = Buffer.concat([header, payloadBuf, offsetTable]);

        const checksum = parseInt(crypto.createHash('sha256').update(fullShard).digest('hex').substring(0, 8), 16);
        fullShard.writeUInt32LE(checksum >>> 0, 15);

        const shardName = `fused-shard-${String(shardId).padStart(3, '0')}.bin`;
        await fs.writeFile(path.join(OUTPUT_DIR, shardName), fullShard);

        manifest[shardName] = {
            slotRange: currentSlotId, entities: currentEntries.length,
            size: fullShard.length, checksum: checksum.toString(16)
        };
        shardId++;
        currentEntries = [];
        currentPayloads = [];
        shardSize = 0;
        payloadOffset = 0;
    };

    const sortedSlots = [...slots.entries()].sort((a, b) => a[0] - b[0]);

    for (const [slotId, entities] of sortedSlots) {
        const slotPayloadSize = entities.reduce((sum, e) => sum + e.payload.length, 0);

        if (shardSize + slotPayloadSize > SHARD_SOFT_LIMIT && currentEntries.length > 0) {
            await flushShard();
        }

        currentSlotId = slotId;

        for (const entity of entities) {
            const offset = HEADER_SIZE + payloadOffset;
            const shardName = `fused-shard-${String(shardId).padStart(3, '0')}.bin`;
            const finalPayload = cryptoEnabled
                ? encryptPayload(shardName, entity.payload, offset)
                : entity.payload;
            currentEntries.push({ umid: entity.umid, offset, size: finalPayload.length });
            currentPayloads.push(finalPayload);
            payloadOffset += finalPayload.length;
            shardSize += finalPayload.length;
        }
    }

    // Flush remaining
    await flushShard();

    // Write manifest
    await fs.writeFile(
        path.join(OUTPUT_DIR, 'v4-manifest.json'),
        JSON.stringify({ version: '4.0', totalShards: shardId, slots: TOTAL_SLOTS, manifest }, null, 2)
    );

    console.log(`[V4-PACKER] Complete: ${shardId} shards, ${slots.size}/${TOTAL_SLOTS} slots`);
}

// CLI entry point
if (process.argv[1]?.endsWith('shard-packer-v4.js')) {
    packV4Shards().catch(err => {
        console.error('[V4-PACKER] Fatal:', err);
        process.exit(1);
    });
}
