// V2.0 Streaming Shard-DB Packer — O(1) memory via PackAccumulator
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { configureDistiller, distillEntity } from './lib/v25-distiller.js';
import { cleanAbstract } from './lib/abstract-cleaner.js';
import { loadTrendingMap, loadTrendMap, ingestToAccumulator, buildBundleJson, buildEntityRow, setupDatabasePragmas, setupFtsPragmas, injectMetadata, printBuildSummary } from './lib/pack-utils.js';
import { computeMetaShardSlot } from './lib/meta-shard-router.js';
import { dbSchemas, ftsDbSchema } from './lib/pack-schemas.js';
import { getV6Category } from './lib/category-stats-generator.js';
import { generateHotShard } from './lib/hot-shard-generator.js';
import { generateVectorCore } from './lib/vector-core-generator.js';
import { finalizePack } from './lib/pack-finalizer.js';
import { ShardWriter } from './lib/shard-writer.js';
import { initRustBridge } from './lib/rust-bridge.js';
import { computeEmbeddings } from './lib/embedding-generator.js';
import { openCache, validateModel, loadIds, saveBatch, closeCache } from './lib/embedding-cache.js';
import { META_SHARD_COUNT } from '../../src/constants/shard-constants.js';

const CACHE_DIR = process.env.CACHE_DIR || './output/cache', SHARD_PATH_DIR = './output/data';
const THRESHOLD_KB = 0, MAX_SHARD_SIZE = 8 * 1024 * 1024, EMBEDDING_STREAM_BATCH = 500;
const EMBEDDING_CACHE_PATH = path.join(CACHE_DIR, 'embedding-cache.db');
const EMBEDDING_MODEL = 'Xenova/bge-base-en-v1.5';

async function computeEmbeddingsStreaming(accumulator, cacheDb) {
    console.log('[VFS] Streaming Embedding Vault Integration...');
    validateModel(cacheDb, EMBEDDING_MODEL);
    const cachedIdSet = loadIds(cacheDb);
    let batch = [];
    for (const entity of accumulator.iterate()) {
        const id = entity.id || entity.slug;
        if (cachedIdSet.has(id)) entity.embedding = true;
        batch.push(entity);
        if (batch.length >= EMBEDDING_STREAM_BATCH) {
            await computeEmbeddings(batch, { onBatchComplete: async (results) => saveBatch(cacheDb, results) });
            batch = [];
        }
    }
    if (batch.length > 0) {
        await computeEmbeddings(batch, { onBatchComplete: async (results) => saveBatch(cacheDb, results) });
    }
    cachedIdSet.clear();
    console.log('[VFS] Memory: Streaming embedding pass complete.');
}

async function packDatabase() {
    const rustStatus = initRustBridge();
    console.log(`[VFS] Rust FFI: ${rustStatus.mode} (${rustStatus.modules.join(', ') || 'JS fallback'})`);
    console.log('[VFS] Commencing V26.5 Streaming Shard-DB Packing (search.db eliminated)...');

    await fs.mkdir(SHARD_PATH_DIR, { recursive: true });
    const oldFiles = await fs.readdir(SHARD_PATH_DIR);
    for (const f of oldFiles) {
        if (f.endsWith('.db') || f.endsWith('.db-journal') || f === 'meta.db') await fs.unlink(path.join(SHARD_PATH_DIR, f));
    }
    const trendingMap = await loadTrendingMap(CACHE_DIR);
    const trendMap = await loadTrendMap(CACHE_DIR);
    const accumulator = await ingestToAccumulator(CACHE_DIR, trendingMap, trendMap);

    const cacheDb = openCache(EMBEDDING_CACHE_PATH);
    await computeEmbeddingsStreaming(accumulator, cacheDb);

    const partitionCounts = { meta_shards: META_SHARD_COUNT };
    console.log(`[VFS] V5.8 Hash-Shard Routing: ${META_SHARD_COUNT} meta shards`);
    const metaDbs = {};
    for (let i = 0; i < META_SHARD_COUNT; i++) {
        metaDbs[`slot_${i}`] = new Database(path.join(SHARD_PATH_DIR, `meta-${String(i).padStart(2, '0')}.db`));
    }
    const ftsDb = new Database(path.join(SHARD_PATH_DIR, 'fts.db'));

    Object.values(metaDbs).forEach(setupDatabasePragmas);
    setupFtsPragmas(ftsDb);

    Object.values(metaDbs).forEach(db => db.exec(dbSchemas));
    ftsDb.exec(ftsDbSchema);

    const placeholder = Array(55).fill('?').join(', ');
    const prepInserts = {};
    for (const [key, db] of Object.entries(metaDbs)) {
        prepInserts[key] = db.prepare(`INSERT INTO entities VALUES (${placeholder})`);
    }
    const insertFts = ftsDb.prepare(`INSERT INTO search (rowid, umid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const getVecStm = cacheDb.prepare('SELECT vector FROM embeddings WHERE id = ?');
    const stats = { packed: 0, heavy: 0, bytes: 0 };
    const manifest = {};
    const shardWriter = new ShardWriter(SHARD_PATH_DIR);
    await shardWriter.init();
    let currentShardName = shardWriter.open();

    Object.values(metaDbs).forEach(db => db.exec("BEGIN TRANSACTION"));
    ftsDb.exec("BEGIN TRANSACTION");

    configureDistiller();
    const entityLookup = accumulator.getEntityLookup();

    const seenUmids = new Set();
    let dupSkipped = 0;
    for (let e of accumulator.iterate()) {
        const umidKey = e.umid || e.id;
        if (seenUmids.has(umidKey)) {
            dupSkipped++;
            console.warn(`[VFS] Skipping duplicate umid ${umidKey} (id=${e.id}, fni=${e.fni_score ?? e.fni ?? 0})`);
            continue;
        }
        seenUmids.add(umidKey);

        const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
        const pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0;
        const ctxLen = e.context_length ?? e.technical?.context_length ?? 0;
        const arch = e.architecture ?? e.technical?.architecture ?? '';

        e = distillEntity(e, pBillions, entityLookup);

        const keywords = e.search_vector || '';
        const bundleJson = buildBundleJson(e, pBillions, ctxLen, arch);
        let bundleKey = null, offset = 0, size = 0;
        if (bundleJson.length > THRESHOLD_KB * 1024) {
            if (shardWriter.wouldExceed(bundleJson.length, MAX_SHARD_SIZE)) {
                currentShardName = shardWriter.nextShard();
            }
            const pos = shardWriter.writeEntity(bundleJson);
            bundleKey = `data/${currentShardName}`; offset = pos.offset; size = pos.size;
            stats.heavy++; stats.bytes += size;
        }

        const rawSummary = e.summary || e.description || e.clean_summary || cleanAbstract(e.body_content, 500) || '';
        const truncatedSummary = rawSummary.length > 500 ? rawSummary.substring(0, 500) + '...' : rawSummary;
        const category = getV6Category(e);
        const tags = Array.isArray(e.tags) ? e.tags.join(', ') : (e.tags || '');

        e.search_vector = keywords;
        const metaValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, truncatedSummary, bundleKey, offset, size);
        const slotId = computeMetaShardSlot(e.slug || e.id, META_SHARD_COUNT);
        prepInserts[`slot_${slotId}`].run(...metaValues);

        const authorStr = Array.isArray(e.author) ? e.author.join(', ') : String(e.author || '');
        const nameStr = String(e.name || e.displayName || '');
        const ftsTagStr = String(tags + ' ' + keywords);
        insertFts.run(stats.packed + 1, String(e.umid || e.id), nameStr, String(truncatedSummary), authorStr, ftsTagStr, String(category));

        stats.packed++;
    }

    Object.values(metaDbs).forEach(db => db.exec("COMMIT"));
    ftsDb.exec("COMMIT");
    shardWriter.finalize();

    if (dupSkipped > 0) console.warn(`[VFS] Pack loop skipped ${dupSkipped} duplicate-umid entities`);

    await finalizePack(metaDbs, ftsDb, manifest, shardWriter.shardId, SHARD_PATH_DIR, CACHE_DIR, stats, partitionCounts, injectMetadata, printBuildSummary);

    const { exportParquet, exportLiteParquet } = await import('./lib/parquet-exporter.js');
    await exportParquet(accumulator);
    await exportLiteParquet(accumulator);
    const { checkFniSanity } = await import('./lib/fni-sanity-check.js');
    const { passed } = checkFniSanity(accumulator);
    if (!passed) {
        await accumulator.close();
        console.error('[VFS] BUILD HALTED: FNI sanity check failed.');
        process.exit(1);
    }
    await accumulator.close();
    entityLookup.clear();
    if (global.gc) global.gc();

    // Phase 6: Top-30k from meta shards (replaces search.db)
    console.log('[VFS] Recovering Top-30k vectors from meta shards...');
    const top30k = [];
    for (const [, db] of Object.entries(metaDbs)) {
        const rows = db.prepare(
            `SELECT id, slug, name, type, author, license, pipeline_tag, category, fni_score,
             downloads, stars, params_billions, context_length, last_modified, is_trending
             FROM entities ORDER BY fni_score DESC, raw_pop DESC, slug ASC LIMIT 30000`
        ).all();
        top30k.push(...rows);
    }
    top30k.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0) || (a.slug || '').localeCompare(b.slug || ''));
    top30k.length = Math.min(top30k.length, 30000);
    for (const row of top30k) {
        const vecRow = getVecStm.get(row.id || row.slug);
        if (vecRow?.vector) {
            const int8 = new Int8Array(vecRow.vector.buffer, vecRow.vector.byteOffset, vecRow.vector.byteLength);
            const float32 = new Float32Array(int8.length);
            for (let j = 0; j < int8.length; j++) float32[j] = int8[j] / 127.0;
            row.embedding = Array.from(float32);
        }
    }
    closeCache(cacheDb);
    await generateHotShard(top30k);
    await generateVectorCore(top30k);

    const { buildClusterAnnIndex } = await import('./lib/cluster-ann-builder.js');
    await buildClusterAnnIndex(EMBEDDING_CACHE_PATH);

    const { generateEdgeIndex } = await import('./lib/edge-index-gen.js');
    const { generateMetaAnchors } = await import('./lib/meta-anchors.js');
    await generateEdgeIndex();
    await generateMetaAnchors();

    // Phase 7: Static Inverted Index — reads from meta shards
    const { buildInvertedIndexFromShards } = await import('./lib/inverted-index-builder.js');
    const termIndexDir = path.join(SHARD_PATH_DIR, 'term_index');
    await buildInvertedIndexFromShards(metaDbs, termIndexDir);
    Object.values(metaDbs).forEach(db => db.close());
    console.log('[VFS] V26.5 Streaming Shard-DB Packing Complete (search.db eliminated).');
}
packDatabase().catch(err => { console.error('Failure:', err); process.exit(1); });
