// V26.7 Streaming Shard-DB Packer — Zero accumulator, O(1) memory
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { configureDistiller, distillEntity } from './lib/v25-distiller.js';
import { cleanAbstract } from './lib/abstract-cleaner.js';
import { loadTrendingMap, loadTrendMap, streamFusedEntities, buildBundleJson, buildEntityRow, setupDatabasePragmas, setupFtsPragmas, injectMetadata, printBuildSummary } from './lib/pack-utils.js';
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
import { loadHostedOnMap, enrichHostedOn } from './lib/hosted-on-enricher.js';

const CACHE_DIR = process.env.CACHE_DIR || './output/cache', SHARD_PATH_DIR = './output/data';
const SLUG_PREFIXES = [
    'hf-model', 'hf-agent', 'hf-tool', 'hf-dataset', 'hf-space', 'hf-paper', 'hf-collection',
    'gh-model', 'gh-agent', 'gh-tool', 'gh-repo',
    'arxiv-paper', 'arxiv', 'paper',
    'replicate-model', 'replicate-agent', 'replicate-space',
    'civitai-model', 'ollama-model',
    'kaggle-dataset', 'kaggle-model',
    'langchain-prompt', 'langchain-agent',
    'knowledge', 'concept', 'report', 'dataset', 'model', 'agent', 'tool', 'space', 'prompt'
];
function deriveSlug(id) {
    let r = (id || '').toLowerCase();
    for (const p of SLUG_PREFIXES) {
        if (r.startsWith(`${p}--`) || r.startsWith(`${p}:`) || r.startsWith(`${p}/`)) {
            r = r.slice(p.length + (r[p.length] === '-' ? 2 : 1)); break;
        }
    }
    return r.replace(/[:\/]/g, '--').replace(/^--|--$/g, '').replace(/--+/g, '--');
}
const THRESHOLD_KB = 0, MAX_SHARD_SIZE = 8 * 1024 * 1024, EMBEDDING_BATCH = 500;
const EMBEDDING_CACHE_PATH = path.join(CACHE_DIR, 'embedding-cache.db');
const EMBEDDING_MODEL = 'Xenova/bge-base-en-v1.5';

async function packDatabase() {
    const rustStatus = initRustBridge();
    console.log(`[VFS] Rust FFI: ${rustStatus.mode} (${rustStatus.modules.join(', ') || 'JS fallback'})`);
    console.log('[VFS] Commencing V26.7 Streaming Packer (zero accumulator)...');

    await fs.mkdir(SHARD_PATH_DIR, { recursive: true });
    for (const f of await fs.readdir(SHARD_PATH_DIR)) {
        if (f.startsWith('rankings-')) continue;
        if (f.endsWith('.db') || f.endsWith('.db-journal') || f === 'meta.db') await fs.unlink(path.join(SHARD_PATH_DIR, f));
    }
    const trendingMap = await loadTrendingMap(CACHE_DIR);
    const trendMap = await loadTrendMap(CACHE_DIR);

    // Combined pre-scan: entity lookup + uncached embedding collection (single pass)
    const cacheDb = openCache(EMBEDDING_CACHE_PATH);
    validateModel(cacheDb, EMBEDDING_MODEL);
    const cachedIdSet = loadIds(cacheDb);
    console.log(`[VFS] Pre-scan: building entity lookup + collecting uncached embeddings (${cachedIdSet.size} cached)...`);
    const entityLookup = new Map();
    const uncachedEntities = [];
    await streamFusedEntities(CACHE_DIR, trendingMap, trendMap, (e) => {
        const id = e.id || e.slug;
        if (id) {
            entityLookup.set(id, { name: e.name || e.displayName || id, icon: e.icon || '' });
            if (!cachedIdSet.has(id)) uncachedEntities.push({ id, name: e.name || '', summary: e.summary || e.clean_summary || e.description || '' });
        }
    });
    console.log(`[VFS] Entity lookup: ${entityLookup.size}. Uncached: ${uncachedEntities.length}. Computing embeddings...`);
    for (let i = 0; i < uncachedEntities.length; i += 500) {
        const batch = uncachedEntities.slice(i, i + 500);
        await computeEmbeddings(batch, { onBatchComplete: async (results) => saveBatch(cacheDb, results) });
        if ((i + 500) % 5000 < 500) console.log(`[VFS] Embeddings: ${Math.min(i + 500, uncachedEntities.length)}/${uncachedEntities.length}...`);
    }
    console.log(`[VFS] Embedding pass complete: ${uncachedEntities.length} newly computed.`);
    console.log(`[VFS] Embedding Vault: ${cachedIdSet.size} cached vectors (model: ${EMBEDDING_MODEL})`);

    // Prepare DBs
    const partitionCounts = { meta_shards: META_SHARD_COUNT };
    const metaDbs = {};
    for (let i = 0; i < META_SHARD_COUNT; i++) {
        metaDbs[`slot_${i}`] = new Database(path.join(SHARD_PATH_DIR, `meta-${String(i).padStart(2, '0')}.db`));
    }
    const ftsDb = new Database(path.join(SHARD_PATH_DIR, 'fts.db'));
    Object.values(metaDbs).forEach(setupDatabasePragmas);
    setupFtsPragmas(ftsDb);
    Object.values(metaDbs).forEach(db => db.exec(dbSchemas));
    ftsDb.exec(ftsDbSchema);

    const placeholder = Array(59).fill('?').join(', ');
    const prepInserts = {};
    for (const [key, db] of Object.entries(metaDbs)) prepInserts[key] = db.prepare(`INSERT INTO entities VALUES (${placeholder})`);
    const insertFts = ftsDb.prepare(`INSERT INTO search (rowid, umid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const getVecStm = cacheDb.prepare('SELECT vector FROM embeddings WHERE id = ?');

    const stats = { packed: 0, heavy: 0, bytes: 0 };
    const manifest = {};
    const shardWriter = new ShardWriter(SHARD_PATH_DIR);
    await shardWriter.init();
    let currentShardName = shardWriter.open();
    const seenUmids = new Set();
    let dupSkipped = 0;

    Object.values(metaDbs).forEach(db => db.exec("BEGIN TRANSACTION"));
    ftsDb.exec("BEGIN TRANSACTION");
    configureDistiller();

    const { map: hostedOnMap, timestamp: hostedOnTs } = loadHostedOnMap(CACHE_DIR);

    // Main pass: stream fused files → per-entity processing → no accumulator
    console.log('[VFS] Main pass: streaming pack...');
    await streamFusedEntities(CACHE_DIR, trendingMap, trendMap, (e) => {
        const umidKey = e.umid || e.id;
        if (seenUmids.has(umidKey)) { dupSkipped++; return; }
        seenUmids.add(umidKey);

        const eid = e.id || e.slug;
        const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
        const pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0;
        const ctxLen = e.context_length ?? e.technical?.context_length ?? 0;
        const arch = e.architecture ?? e.technical?.architecture ?? '';

        e = distillEntity(e, pBillions, entityLookup);
        enrichHostedOn(e, hostedOnMap, hostedOnTs);

        const keywords = e.search_vector || '';
        const bundleJson = buildBundleJson(e, pBillions, ctxLen, arch);
        let bundleKey = null, offset = 0, size = 0;
        if (bundleJson.length > THRESHOLD_KB * 1024) {
            if (shardWriter.wouldExceed(bundleJson.length, MAX_SHARD_SIZE)) currentShardName = shardWriter.nextShard();
            const pos = shardWriter.writeEntity(bundleJson);
            bundleKey = `data/${currentShardName}`; offset = pos.offset; size = pos.size;
            stats.heavy++; stats.bytes += size;
        }

        const rawSummary = e.summary || e.description || e.clean_summary || cleanAbstract(e.body_content, 500) || '';
        const truncatedSummary = rawSummary.length > 500 ? rawSummary.substring(0, 500) + '...' : rawSummary;
        const category = getV6Category(e);
        const tags = Array.isArray(e.tags) ? e.tags.join(', ') : (e.tags || '');
        e.search_vector = keywords;
        if (!e.slug && e.id) e.slug = deriveSlug(e.id);

        const metaValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, truncatedSummary, bundleKey, offset, size);
        const slotId = computeMetaShardSlot(e.slug || e.id, META_SHARD_COUNT);
        prepInserts[`slot_${slotId}`].run(...metaValues);

        const authorStr = Array.isArray(e.author) ? e.author.join(', ') : String(e.author || '');
        const nameStr = String(e.name || e.displayName || '');
        const ftsTagStr = String(tags + ' ' + keywords);
        insertFts.run(stats.packed + 1, String(e.umid || e.id), nameStr, String(truncatedSummary), authorStr, ftsTagStr, String(category));

        stats.packed++;
    });

    cachedIdSet.clear();

    Object.values(metaDbs).forEach(db => db.exec("COMMIT"));
    ftsDb.exec("COMMIT");
    shardWriter.finalize();
    if (dupSkipped > 0) console.warn(`[VFS] Pack loop skipped ${dupSkipped} duplicate-umid entities`);

    await finalizePack(metaDbs, ftsDb, manifest, shardWriter.shardId, SHARD_PATH_DIR, CACHE_DIR, stats, partitionCounts, injectMetadata, printBuildSummary);

    // FNI sanity check from meta shards
    let totalFni = 0, zeroFni = 0, maxFni = 0, allScores = [];
    for (const db of Object.values(metaDbs)) {
        for (const r of db.prepare('SELECT fni_score FROM entities').iterate()) {
            const s = r.fni_score || 0;
            if (s === 0) zeroFni++;
            if (s > maxFni) maxFni = s;
            allScores.push(s);
            totalFni++;
        }
    }
    allScores.sort((a, b) => a - b);
    const median = allScores[Math.floor(allScores.length / 2)] || 0;
    const zeroRatio = totalFni > 0 ? zeroFni / totalFni : 0;
    console.log(`[FNI-CHECK] total=${totalFni} zero=${zeroFni} (${(zeroRatio * 100).toFixed(1)}%) median=${median.toFixed(1)} max=${maxFni.toFixed(1)}`);
    if (zeroRatio > 0.05 || maxFni > 99.9 || median < 10) {
        console.error('[VFS] BUILD HALTED: FNI sanity check failed.'); process.exit(1);
    }

    // Parquet from meta shards
    const { exportParquetFromShards, exportLiteParquetFromShards } = await import('./lib/parquet-exporter.js');
    await exportParquetFromShards(metaDbs);
    await exportLiteParquetFromShards(metaDbs);

    // Top-30k from meta shards (SQLite indexed query, fast)
    console.log('[VFS] Recovering Top-30k vectors from meta shards...');
    const top30k = [];
    for (const db of Object.values(metaDbs)) {
        const rows = db.prepare(
            `SELECT id, slug, name, type, author, license, pipeline_tag, category, fni_score,
             downloads, stars, params_billions, context_length, last_modified, is_trending
             FROM entities ORDER BY fni_score DESC, raw_pop DESC, slug ASC LIMIT 30000`
        ).all();
        top30k.push(...rows);
    }
    top30k.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
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
    const withVec = top30k.filter(r => r.embedding).length;
    console.log(`[VFS] Top-30k vectors: ${withVec}/${top30k.length} populated from Embedding Vault`);
    closeCache(cacheDb);
    await generateHotShard(top30k);
    await generateVectorCore(top30k);

    const { buildClusterAnnIndex } = await import('./lib/cluster-ann-builder.js');
    await buildClusterAnnIndex(EMBEDDING_CACHE_PATH);

    const { generateEdgeIndex } = await import('./lib/edge-index-gen.js');
    const { generateMetaAnchors } = await import('./lib/meta-anchors.js');
    await generateEdgeIndex();
    await generateMetaAnchors();

    const { buildInvertedIndexFromShards } = await import('./lib/inverted-index-builder.js');
    await buildInvertedIndexFromShards(metaDbs, path.join(SHARD_PATH_DIR, 'term_index'));
    Object.values(metaDbs).forEach(db => db.close());
    entityLookup.clear();
    if (global.gc) global.gc();
    console.log('[VFS] V26.7 Streaming Packer Complete (zero accumulator).');
}
packDatabase().catch(err => { console.error('Failure:', err); process.exit(1); });
