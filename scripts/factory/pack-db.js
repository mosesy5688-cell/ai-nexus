/**
 * V23.1 Sharded Binary DB Packer (Serverless Search Engine)
 * Architecture: Modular (CES Compliant) Hash-Shard DBs
 */

import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { configureDistiller, distillEntity } from './lib/v25-distiller.js';
import {
    loadTrendingMap, loadTrendMap, collectAndSortMetadata,
    buildBundleJson, buildEntityRow,
    setupDatabasePragmas, setupFtsPragmas, injectMetadata, printBuildSummary
} from './lib/pack-utils.js';
import { computeShardSlot } from './lib/umid-generator.js';
import { dbSchemas, searchDbSchema, ftsDbSchema } from './lib/pack-schemas.js';
import { getV6Category } from './lib/category-stats-generator.js';
import { generateHotShard } from './lib/hot-shard-generator.js';
import { generateVectorCore } from './lib/vector-core-generator.js';
import { finalizePack } from './lib/pack-finalizer.js';
import { ShardWriter } from './lib/shard-writer.js';

const CACHE_DIR = process.env.CACHE_DIR || './output/cache', SEARCH_DB_PATH = './output/data/search.db', SHARD_PATH_DIR = './output/data';
const THRESHOLD_KB = 0, MAX_SHARD_SIZE = 8 * 1024 * 1024; // V25.8 §1.1: 8MB hard-cap per spec

async function packDatabase() {
    console.log('[VFS] 💎 Commencing Constitutional V23.1 Shard-DB Packing...');

    await fs.mkdir(SHARD_PATH_DIR, { recursive: true });

    // Cleanup old DBs
    const oldFiles = await fs.readdir(SHARD_PATH_DIR);
    for (const f of oldFiles) {
        if (f.endsWith('.db') || f.endsWith('.db-journal') || f === 'meta.db') {
            await fs.unlink(path.join(SHARD_PATH_DIR, f));
        }
    }

    const trendingMap = await loadTrendingMap(CACHE_DIR);
    const trendMap = await loadTrendMap(CACHE_DIR);
    const metadataBatch = await collectAndSortMetadata(CACHE_DIR, trendingMap, trendMap);

    // V5.8 §1.1: 16-way hash-based meta sharding — meta-${SlotID % 16}.db
    const META_SHARD_COUNT = 16;
    const partitionCounts = { meta_shards: META_SHARD_COUNT };

    console.log(`[VFS] V5.8 Hash-Shard Routing: ${META_SHARD_COUNT} meta shards (SlotID % ${META_SHARD_COUNT})`);

    const metaDbs = {};
    for (let i = 0; i < META_SHARD_COUNT; i++) {
        const key = `slot_${i}`;
        metaDbs[key] = new Database(path.join(SHARD_PATH_DIR, `meta-${String(i).padStart(2, '0')}.db`));
    }

    const searchDb = new Database(SEARCH_DB_PATH);

    // V25.8: Standalone FTS5 database (decoupled from meta.db)
    const FTS_DB_PATH = path.join(SHARD_PATH_DIR, 'fts.db');
    const ftsDb = new Database(FTS_DB_PATH);

    Object.values(metaDbs).forEach(setupDatabasePragmas);
    setupDatabasePragmas(searchDb);
    setupFtsPragmas(ftsDb); // V5.8 §1.1: WAL mode + incremental merge for FTS5

    Object.values(metaDbs).forEach(db => db.exec(dbSchemas));
    searchDb.exec(searchDbSchema);
    ftsDb.exec(ftsDbSchema);

    // Prepare Statements
    const placeholder = Array(54).fill('?').join(', ');
    const prepInserts = {}, prepFts = {};

    for (const [key, db] of Object.entries(metaDbs)) {
        prepInserts[key] = db.prepare(`INSERT INTO entities VALUES (${placeholder})`);
        prepFts[key] = db.prepare(`INSERT INTO search (rowid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?)`);
    }
    const insertEntitySearch = searchDb.prepare(`INSERT INTO entities VALUES (${placeholder})`);
    // V25.8: Decoupled FTS5 insert (umid-keyed for cross-DB joins)
    const insertFts = ftsDb.prepare(`INSERT INTO search (rowid, umid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const stats = { packed: 0, heavy: 0, bytes: 0 };
    const manifest = {};

    // V25.8: Shard Header V4.0 + Zstd via ShardWriter (extracted for CES compliance)
    const shardWriter = new ShardWriter(SHARD_PATH_DIR);
    await shardWriter.init();
    let currentShardName = shardWriter.open();

    Object.values(metaDbs).forEach(db => db.exec("BEGIN TRANSACTION"));
    searchDb.exec("BEGIN TRANSACTION");
    ftsDb.exec("BEGIN TRANSACTION");

    let rowIds = {};
    Object.keys(metaDbs).forEach(k => rowIds[k] = 1);

    // V25.1 Compute Shift-Left: Initialize Distiller
    configureDistiller();

    const entityLookup = new Map();
    metadataBatch.forEach(e => {
        entityLookup.set(e.id || e.slug, {
            name: e.name || e.displayName || (e.id || e.slug),
            icon: e.icon || '📦'
        });
    });

    for (let e of metadataBatch) {
        const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
        const pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0;
        const ctxLen = e.context_length ?? e.technical?.context_length ?? 0;
        const arch = e.architecture ?? e.technical?.architecture ?? '';

        // V25.1 Distillation Pipeline
        e = distillEntity(e, pBillions, entityLookup);

        const bundleJson = buildBundleJson(e, fniMetrics, pBillions, ctxLen, arch);
        let bundleKey = null, offset = 0, size = 0;
        if (bundleJson.length > THRESHOLD_KB * 1024) {
            if (shardWriter.wouldExceed(bundleJson.length, MAX_SHARD_SIZE)) {
                currentShardName = shardWriter.nextShard();
            }
            const pos = shardWriter.writeEntity(bundleJson);
            bundleKey = `data/${currentShardName}`; offset = pos.offset; size = pos.size;
            stats.heavy++; stats.bytes += size;
        }

        const rawSummary = e.summary || e.description || e.body_content || '';
        const truncatedSummary = rawSummary.length > 500 ? rawSummary.substring(0, 500) + '...' : rawSummary;
        const category = getV6Category(e);
        const tags = Array.isArray(e.tags) ? e.tags.join(', ') : (e.tags || '');

        const metaValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, truncatedSummary, bundleKey, offset, size);
        const searchValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, rawSummary, bundleKey, offset, size);

        // V5.8 §1.1: 16-way hash routing — SlotID = computeShardSlot(UMID, 16)
        const slotId = computeShardSlot(e.umid || e.slug || e.id, META_SHARD_COUNT);
        const targetKey = `slot_${slotId}`;

        prepInserts[targetKey].run(...metaValues);
        insertEntitySearch.run(...searchValues);

        const ftsValues = [
            rowIds[targetKey]++,
            String(e.name || e.displayName || ''),
            String(truncatedSummary),
            Array.isArray(e.author) ? e.author.join(', ') : String(e.author || ''),
            String(tags + " " + (e.search_vector || '')),
            String(category)
        ];
        prepFts[targetKey].run(...ftsValues);

        // V25.8: Insert into decoupled fts.db (UMID-keyed)
        insertFts.run(
            stats.packed + 1,
            String(e.umid || e.id),
            String(e.name || e.displayName || ''),
            String(truncatedSummary),
            Array.isArray(e.author) ? e.author.join(', ') : String(e.author || ''),
            String(tags + ' ' + (e.search_vector || '')),
            String(category)
        );

        stats.packed++;
    }

    Object.values(metaDbs).forEach(db => db.exec("COMMIT"));
    searchDb.exec("COMMIT");
    ftsDb.exec("COMMIT");
    shardWriter.finalize(); // V25.8: Patch shard header + write offset table

    // ── V22.9/V22.10: Generation ─────────
    generateHotShard(metadataBatch);
    generateVectorCore(metadataBatch);

    // V25.8: Finalize shard hashes, optimize DBs, generate indexes
    await finalizePack(metaDbs, searchDb, ftsDb, manifest, shardWriter.shardId, SHARD_PATH_DIR, CACHE_DIR, stats, partitionCounts, injectMetadata, printBuildSummary);
}

packDatabase().catch(err => { console.error('❌ Failure:', err); process.exit(1); });
