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
import { initRustBridge } from './lib/rust-bridge.js';
import { computeEmbeddings } from './lib/embedding-generator.js';
import { openCache, validateModel, loadIds, saveBatch, closeCache } from './lib/embedding-cache.js';

const CACHE_DIR = process.env.CACHE_DIR || './output/cache', SEARCH_DB_PATH = './output/data/search.db', SHARD_PATH_DIR = './output/data';
const THRESHOLD_KB = 0, MAX_SHARD_SIZE = 8 * 1024 * 1024; 
const EMBEDDING_CACHE_PATH = path.join(CACHE_DIR, 'embedding-cache.db');
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

async function packDatabase() {
    // V25.8: Activate Rust FFI bridge
    const rustStatus = initRustBridge();
    console.log(`[VFS] Rust FFI: ${rustStatus.mode} (${rustStatus.modules.join(', ') || 'JS fallback'})`);

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
    let metadataBatch = await collectAndSortMetadata(CACHE_DIR, trendingMap, trendMap);

    // V25.8.3: Memory-Stable Embedding Vault Integration
    console.log('[VFS] 🔐 Accessing Embedding Vault...');
    const cacheDb = openCache(EMBEDDING_CACHE_PATH);
    validateModel(cacheDb, EMBEDDING_MODEL);
    
    // Memory Guard: Only load IDs for skip-check, not the actual vectors.
    const cachedIdSet = loadIds(cacheDb);
    metadataBatch.forEach(e => {
        if (cachedIdSet.has(e.id || e.slug)) {
            // Marker to trigger computeEmbeddings skip (generator updated to support boolean)
            e.embedding = true; 
        }
    });

    // V25.8.3 P1: Compute/Update ANN Vault
    await computeEmbeddings(metadataBatch, {
        onBatchComplete: async (batch) => {
            saveBatch(cacheDb, batch);
        }
    });

    // Memory Guard: Wipe ALL embedding references to free heap before packing.
    // Includes both boolean markers (cached) AND real arrays (newly computed).
    // All vectors are safely persisted in cacheDb via onBatchComplete.
    metadataBatch.forEach(e => { e.embedding = null; });
    cachedIdSet.clear(); 
    console.log('[VFS] Memory: Baseline stabilized for shard packing.');

    const META_SHARD_COUNT = 16;
    const partitionCounts = { meta_shards: META_SHARD_COUNT };
    console.log(`[VFS] V5.8 Hash-Shard Routing: ${META_SHARD_COUNT} meta shards`);

    const metaDbs = {};
    for (let i = 0; i < META_SHARD_COUNT; i++) {
        const key = `slot_${i}`;
        metaDbs[key] = new Database(path.join(SHARD_PATH_DIR, `meta-${String(i).padStart(2, '0')}.db`));
    }

    const searchDb = new Database(SEARCH_DB_PATH);
    const FTS_DB_PATH = path.join(SHARD_PATH_DIR, 'fts.db');
    const ftsDb = new Database(FTS_DB_PATH);

    Object.values(metaDbs).forEach(setupDatabasePragmas);
    setupDatabasePragmas(searchDb);
    setupFtsPragmas(ftsDb);

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
    const insertFts = ftsDb.prepare(`INSERT INTO search (rowid, umid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    
    // V25.8.3: Streaming Vector Query
    const getVecStm = cacheDb.prepare('SELECT vector FROM embeddings WHERE id = ?');

    const stats = { packed: 0, heavy: 0, bytes: 0 };
    const manifest = {};
    const shardWriter = new ShardWriter(SHARD_PATH_DIR);
    await shardWriter.init();
    let currentShardName = shardWriter.open();

    Object.values(metaDbs).forEach(db => db.exec("BEGIN TRANSACTION"));
    searchDb.exec("BEGIN TRANSACTION");
    ftsDb.exec("BEGIN TRANSACTION");

    let rowIds = {};
    Object.keys(metaDbs).forEach(k => rowIds[k] = 1);

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

        e = distillEntity(e, pBillions, entityLookup);
        
        // V25.8.3: Streaming Injection
        const keywords = e.search_vector || '';
        const vecRow = getVecStm.get(e.id || e.slug);
        if (vecRow && vecRow.vector) {
            e.search_vector = Buffer.from(vecRow.vector).toString('base64');
        }

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

        // Restore keywords to keep metadataBatch light
        e.search_vector = keywords;

        const slotId = computeShardSlot(e.umid || e.slug || e.id, META_SHARD_COUNT);
        const targetKey = `slot_${slotId}`;

        prepInserts[targetKey].run(...metaValues);
        insertEntitySearch.run(...searchValues);

        const ftsValues = [
            rowIds[targetKey]++,
            String(e.name || e.displayName || ''),
            String(truncatedSummary),
            Array.isArray(e.author) ? e.author.join(', ') : String(e.author || ''),
            String(tags + " " + keywords), 
            String(category)
        ];
        prepFts[targetKey].run(...ftsValues);

        insertFts.run(
            stats.packed + 1,
            String(e.umid || e.id),
            String(e.name || e.displayName || ''),
            String(truncatedSummary),
            Array.isArray(e.author) ? e.author.join(', ') : String(e.author || ''),
            String(tags + ' ' + keywords), 
            String(category)
        );

        stats.packed++;
    }

    Object.values(metaDbs).forEach(db => db.exec("COMMIT"));
    searchDb.exec("COMMIT");
    ftsDb.exec("COMMIT");
    shardWriter.finalize();

    await finalizePack(metaDbs, searchDb, ftsDb, manifest, shardWriter.shardId, SHARD_PATH_DIR, CACHE_DIR, stats, partitionCounts, injectMetadata, printBuildSummary);

    // V25.8.3: Top-K Vector Recovery for Core Shards
    console.log('[VFS] 📥 Recovering Top-30k vectors for Core Shards...');
    const topCount = Math.min(metadataBatch.length, 30000);
    for (let i = 0; i < topCount; i++) {
        const e = metadataBatch[i];
        const vecRow = getVecStm.get(e.id || e.slug);
        if (vecRow && vecRow.vector) {
            const int8 = new Int8Array(vecRow.vector.buffer, vecRow.vector.byteOffset, vecRow.vector.byteLength);
            const float32 = new Float32Array(int8.length);
            for (let j = 0; j < int8.length; j++) float32[j] = int8[j] / 127.0;
            e.embedding = Array.from(float32);
        }
    }

    closeCache(cacheDb); 

    generateHotShard(metadataBatch);
    generateVectorCore(metadataBatch);

    metadataBatch = null;
    console.log('[VFS] Memory: metadataBatch disposed. Triggering Edge-Index...');

    const { generateEdgeIndex } = await import('./lib/edge-index-gen.js');
    const { generateMetaAnchors } = await import('./lib/meta-anchors.js');
    await generateEdgeIndex();
    await generateMetaAnchors();

    console.log('[VFS] V25.8 Shard-DB Packing Complete.');
}

packDatabase().catch(err => { console.error('❌ Failure:', err); process.exit(1); });
