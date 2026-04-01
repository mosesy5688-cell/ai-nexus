// V25.9 Streaming Shard-DB Packer — O(1) memory via PackAccumulator (~200MB peak)
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { configureDistiller, distillEntity } from './lib/v25-distiller.js';
import {
    loadTrendingMap, loadTrendMap, ingestToAccumulator,
    buildBundleJson, buildEntityRow,
    setupDatabasePragmas, setupFtsPragmas, injectMetadata, printBuildSummary
} from './lib/pack-utils.js';
import { computeMetaShardSlot } from './lib/meta-shard-router.js';
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
const THRESHOLD_KB = 0, MAX_SHARD_SIZE = 8 * 1024 * 1024, EMBEDDING_STREAM_BATCH = 500;
const EMBEDDING_CACHE_PATH = path.join(CACHE_DIR, 'embedding-cache.db');
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

// V25.9: Streaming Embedding — iterate accumulator in small batches, GC after persist
async function computeEmbeddingsStreaming(accumulator, cacheDb) {
    console.log('[VFS] 🔐 Streaming Embedding Vault Integration...');
    validateModel(cacheDb, EMBEDDING_MODEL);
    const cachedIdSet = loadIds(cacheDb);

    let batch = [];
    for (const entity of accumulator.iterate()) {
        const id = entity.id || entity.slug;
        if (cachedIdSet.has(id)) entity.embedding = true;
        batch.push(entity);

        if (batch.length >= EMBEDDING_STREAM_BATCH) {
            await computeEmbeddings(batch, {
                onBatchComplete: async (results) => saveBatch(cacheDb, results)
            });
            batch = [];
        }
    }
    if (batch.length > 0) {
        await computeEmbeddings(batch, {
            onBatchComplete: async (results) => saveBatch(cacheDb, results)
        });
    }

    cachedIdSet.clear();
    console.log('[VFS] Memory: Streaming embedding pass complete. No heap residue.');
}

async function packDatabase() {
    const rustStatus = initRustBridge();
    console.log(`[VFS] Rust FFI: ${rustStatus.mode} (${rustStatus.modules.join(', ') || 'JS fallback'})`);
    console.log('[VFS] 💎 Commencing V25.9 Streaming Shard-DB Packing...');

    await fs.mkdir(SHARD_PATH_DIR, { recursive: true });
    const oldFiles = await fs.readdir(SHARD_PATH_DIR);
    for (const f of oldFiles) {
        if (f.endsWith('.db') || f.endsWith('.db-journal') || f === 'meta.db') await fs.unlink(path.join(SHARD_PATH_DIR, f));
    }
    // ── Phase 1: Ingest to SQLite Accumulator (replaces in-memory array) ──
    const trendingMap = await loadTrendingMap(CACHE_DIR);
    const trendMap = await loadTrendMap(CACHE_DIR);
    const accumulator = await ingestToAccumulator(CACHE_DIR, trendingMap, trendMap);

    // ── Phase 2: Streaming Embedding Computation ──
    const cacheDb = openCache(EMBEDDING_CACHE_PATH);
    await computeEmbeddingsStreaming(accumulator, cacheDb);

    // ── Phase 3: Setup Shard DBs ──
    const META_SHARD_COUNT = 32;
    const partitionCounts = { meta_shards: META_SHARD_COUNT };
    console.log(`[VFS] V5.8 Hash-Shard Routing: ${META_SHARD_COUNT} meta shards`);
    const metaDbs = {};
    for (let i = 0; i < META_SHARD_COUNT; i++) {
        metaDbs[`slot_${i}`] = new Database(path.join(SHARD_PATH_DIR, `meta-${String(i).padStart(2, '0')}.db`));
    }
    const searchDb = new Database(SEARCH_DB_PATH);
    const ftsDb = new Database(path.join(SHARD_PATH_DIR, 'fts.db'));

    Object.values(metaDbs).forEach(setupDatabasePragmas);
    setupDatabasePragmas(searchDb);
    setupFtsPragmas(ftsDb);

    Object.values(metaDbs).forEach(db => db.exec(dbSchemas));
    searchDb.exec(searchDbSchema);
    ftsDb.exec(ftsDbSchema);

    // Prepare Statements
    const placeholder = Array(54).fill('?').join(', ');
    const prepInserts = {};

    const prepFts = {};
    for (const [key, db] of Object.entries(metaDbs)) {
        prepInserts[key] = db.prepare(`INSERT INTO entities VALUES (${placeholder})`);
        prepFts[key] = db.prepare(`INSERT INTO search (rowid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?)`);
    }
    const shardFtsRowIds = Object.fromEntries(Object.keys(metaDbs).map(k => [k, 1]));
    const insertEntitySearch = searchDb.prepare(`INSERT INTO entities VALUES (${placeholder})`);
    const insertSearchFts = searchDb.prepare(`INSERT INTO search (rowid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?)`);
    const insertFts = ftsDb.prepare(`INSERT INTO search (rowid, umid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    // V25.8.3: Streaming Vector Query (from embedding cache)
    const getVecStm = cacheDb.prepare('SELECT vector FROM embeddings WHERE id = ?');

    const stats = { packed: 0, heavy: 0, bytes: 0 };
    const manifest = {};
    const shardWriter = new ShardWriter(SHARD_PATH_DIR);
    await shardWriter.init();
    let currentShardName = shardWriter.open();

    Object.values(metaDbs).forEach(db => db.exec("BEGIN TRANSACTION"));
    searchDb.exec("BEGIN TRANSACTION");
    ftsDb.exec("BEGIN TRANSACTION");

    let searchFtsRowId = 1;

    configureDistiller();

    // V25.9: Build entity lookup from accumulator (O(1) per-entity, ~40MB total)
    const entityLookup = accumulator.getEntityLookup();

    // ── Phase 4: Streaming Pack Loop — iterate accumulator, never materialize full array ──
    for (let e of accumulator.iterate()) {
        const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
        const pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0;
        const ctxLen = e.context_length ?? e.technical?.context_length ?? 0;
        const arch = e.architecture ?? e.technical?.architecture ?? '';

        e = distillEntity(e, pBillions, entityLookup);

        // V25.8.3: Selective Injection (Zero-Heap Persistent Pattern)
        const keywords = e.search_vector || '';
        const vecRow = getVecStm.get(e.id || e.slug);
        const annVectorBase64 = (vecRow && vecRow.vector) ? Buffer.from(vecRow.vector).toString('base64') : '';

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

        // V25.8.3 ARCH SPLIT:
        // 1. Meta Values (for Slots): Use original keywords to keep DB < 100MB
        e.search_vector = keywords;
        const metaValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, truncatedSummary, bundleKey, offset, size);

        // 2. Search Values (for full-search): Use full ANN Vector for semantic discovery
        e.search_vector = annVectorBase64 || keywords;
        const searchValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, rawSummary, bundleKey, offset, size);

        e.search_vector = keywords;

        const slotId = computeMetaShardSlot(e.slug || e.id, META_SHARD_COUNT);
        const targetKey = `slot_${slotId}`;

        prepInserts[targetKey].run(...metaValues);
        insertEntitySearch.run(...searchValues);

        const authorStr = Array.isArray(e.author) ? e.author.join(', ') : String(e.author || '');
        const nameStr = String(e.name || e.displayName || '');
        const ftsTagStr = String(tags + ' ' + keywords);
        const catStr = String(category);

        // Per-shard FTS5 (SSR federated search) + unified search.db FTS5 + standalone fts.db
        prepFts[targetKey].run(shardFtsRowIds[targetKey]++, nameStr, String(truncatedSummary), authorStr, ftsTagStr, catStr);
        insertSearchFts.run(searchFtsRowId++, nameStr, String(truncatedSummary), authorStr, ftsTagStr, catStr);
        insertFts.run(stats.packed + 1, String(e.umid || e.id), nameStr, String(truncatedSummary), authorStr, ftsTagStr, catStr);

        stats.packed++;
    }

    Object.values(metaDbs).forEach(db => db.exec("COMMIT"));
    searchDb.exec("COMMIT");
    ftsDb.exec("COMMIT");
    shardWriter.finalize();

    await finalizePack(metaDbs, searchDb, ftsDb, manifest, shardWriter.shardId, SHARD_PATH_DIR, CACHE_DIR, stats, partitionCounts, injectMetadata, printBuildSummary);

    // ── Phase 5: Parquet + FNI (before accumulator close) ──
    const { exportParquet, exportLiteParquet } = await import('./lib/parquet-exporter.js');
    await exportParquet(accumulator);
    await exportLiteParquet(accumulator);
    const { checkFniSanity } = await import('./lib/fni-sanity-check.js');
    const { passed } = checkFniSanity(accumulator);
    if (!passed) {
        await accumulator.close();
        console.error('[VFS] BUILD HALTED: FNI sanity check failed. Artifacts not safe for deploy.');
        process.exit(1);
    }
    await accumulator.close();
    entityLookup.clear();
    if (global.gc) global.gc();
    console.log('[VFS] Memory: Accumulator disposed. Heap released.');

    // ── Phase 6: Top-30k from search.db (structured columns, no JSON blob parsing) ──
    console.log('[VFS] 📥 Recovering Top-30k vectors from search.db...');
    const readDb = new Database(SEARCH_DB_PATH, { readonly: true });
    const top30kStmt = readDb.prepare(
        `SELECT id, slug, name, type, author, license, pipeline_tag, category, fni_score,
         downloads, stars, params_billions, context_length, last_modified, is_trending
         FROM entities ORDER BY fni_score DESC, raw_pop DESC, slug ASC LIMIT 30000`
    );
    const top30k = [];
    for (const row of top30kStmt.iterate()) {
        const vecRow = getVecStm.get(row.id || row.slug);
        if (vecRow?.vector) {
            const int8 = new Int8Array(vecRow.vector.buffer, vecRow.vector.byteOffset, vecRow.vector.byteLength);
            const float32 = new Float32Array(int8.length);
            for (let j = 0; j < int8.length; j++) float32[j] = int8[j] / 127.0;
            row.embedding = Array.from(float32);
        }
        top30k.push(row);
    }
    readDb.close();
    closeCache(cacheDb);
    await generateHotShard(top30k);
    await generateVectorCore(top30k);

    const { generateEdgeIndex } = await import('./lib/edge-index-gen.js');
    const { generateMetaAnchors } = await import('./lib/meta-anchors.js');
    await generateEdgeIndex();
    await generateMetaAnchors();

    // ── Phase 7: Static Inverted Index (V∞ Phase 1A-β) ──
    const { buildInvertedIndex } = await import('./lib/inverted-index-builder.js');
    const termIndexDir = path.join(SHARD_PATH_DIR, 'term_index');
    await buildInvertedIndex(SEARCH_DB_PATH, termIndexDir);

    console.log('[VFS] ✅ V25.9 Streaming Shard-DB Packing Complete.');
}

packDatabase().catch(err => { console.error('❌ Failure:', err); process.exit(1); });
