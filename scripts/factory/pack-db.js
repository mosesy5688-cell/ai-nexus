// V27.0 Streaming Shard-DB Packer — Per-shard embeddings, zero accumulator
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
const fsp = fs, VEC_DIM = 768;
import { configureDistiller, distillEntity, flushDistillerCache, getDistillerStats } from './lib/v25-distiller.js';
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
import { openCache, validateModel, closeCache } from './lib/embedding-cache.js';
import { scanAllShardIds, writeEmbeddingShard, readEmbeddingShard, iterateAllVectors } from './lib/embedding-shard-cache.js';
import { createEntityLookupAccess, getEntityLookupSize, finalizeStreamingPack, resolveMeshFixup } from './lib/entity-lookup-cache.js';
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
const PACK_STATE_PATH = path.join(CACHE_DIR, 'pack-state.db');
const EMBED_SHARD_DIR = path.join(CACHE_DIR, 'embeddings');
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

    // V27.0: pack-state.db for entity_lookup/html_cache; embeddings in per-shard binaries
    const cacheDb = openCache(PACK_STATE_PATH);
    validateModel(cacheDb, EMBEDDING_MODEL);
    await fsp.mkdir(EMBED_SHARD_DIR, { recursive: true });
    const cachedIdToShard = await scanAllShardIds(EMBED_SHARD_DIR);
    const cachedIdSet = new Set(cachedIdToShard.keys());
    const lookupAccess = createEntityLookupAccess(cacheDb);
    console.log(`[VFS] entity_lookup ready (${getEntityLookupSize(cacheDb)} persisted), ${cachedIdSet.size} sharded embeddings.`);

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
    const stats = { packed: 0, heavy: 0, bytes: 0 };
    const manifest = {};
    const shardWriter = new ShardWriter(SHARD_PATH_DIR);
    await shardWriter.init();
    let currentShardName = shardWriter.open();
    const seenUmids = new Set();
    let dupSkipped = 0;

    Object.values(metaDbs).forEach(db => db.exec("BEGIN TRANSACTION"));
    ftsDb.exec("BEGIN TRANSACTION");
    configureDistiller(cacheDb);  // V25.12: pass cacheDb for HTML render cache

    const { map: hostedOnMap, timestamp: hostedOnTs } = loadHostedOnMap(CACHE_DIR);

    // V27.0: Track uncached entities with their shard index for per-shard embedding write
    const uncachedByShard = new Map();

    console.log('[VFS] Single-pass streaming pack...');
    await streamFusedEntities(CACHE_DIR, trendingMap, trendMap, (e, shardIdx) => {
        const umidKey = e.umid || e.id;
        if (seenUmids.has(umidKey)) { dupSkipped++; return; }
        seenUmids.add(umidKey);

        const eid = e.id || e.slug;

        // V25.12: Streaming lookup track (bounded batch, INSERT OR IGNORE)
        if (eid) lookupAccess.trackEntity(eid, e.name || e.displayName || eid, e.icon || '');
        if (eid && !cachedIdSet.has(eid)) {
            if (!uncachedByShard.has(shardIdx)) uncachedByShard.set(shardIdx, []);
            uncachedByShard.get(shardIdx).push({ id: eid, name: e.name || '', summary: e.summary || e.clean_summary || e.description || '' });
        }

        const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
        const pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0;
        const ctxLen = e.context_length ?? e.technical?.context_length ?? 0;
        const arch = e.architecture ?? e.technical?.architecture ?? '';

        e = distillEntity(e, pBillions, lookupAccess.lookup);
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

    // V27.0: Post-pass — compute embeddings per-shard, write binary shards
    const idToShardIdx = new Map();
    const uncachedEntities = [];
    for (const [si, arr] of uncachedByShard) { for (const e of arr) { idToShardIdx.set(e.id, si); uncachedEntities.push(e); } }
    const pendingByShardIdx = new Map();
    await finalizeStreamingPack({
        cacheDb, lookupAccess, uncachedEntities,
        computeEmbeddings, saveBatch: (_db, batch) => {
            for (const item of batch) {
                const si = idToShardIdx.get(item.id) ?? 0;
                if (!pendingByShardIdx.has(si)) pendingByShardIdx.set(si, []);
                pendingByShardIdx.get(si).push(item);
            }
        }, flushDistillerCache, getDistillerStats
    });
    for (const [si, items] of pendingByShardIdx) {
        const existing = readEmbeddingShard(EMBED_SHARD_DIR, si) || new Map();
        for (const it of items) { const int8 = new Int8Array(it.embedding.length); for (let i = 0; i < it.embedding.length; i++) int8[i] = Math.max(-128, Math.min(127, Math.round(it.embedding[i] * 127))); existing.set(it.id, Buffer.from(int8.buffer)); }
        writeEmbeddingShard(EMBED_SHARD_DIR, si, [...existing.entries()].map(([id, vector]) => ({ id, vector })));
    }
    console.log(`[VFS] Wrote ${pendingByShardIdx.size} embedding shards (${uncachedEntities.length} new vectors)`);

    // V25.12: Mesh fix-up — re-resolve forward refs that missed the streaming
    // SQLite proxy during main pass. Runs AFTER lookupAccess.flush so
    // entity_lookup is complete; runs BEFORE finalizePack VACUUM to avoid
    // re-fragmenting the meta DBs.
    const meshFix = resolveMeshFixup(cacheDb, metaDbs);
    if (meshFix.rowsUpdated > 0) {
        console.log(`[VFS] Mesh fix-up: ${meshFix.refsResolved} refs re-resolved across ${meshFix.rowsUpdated} entities.`);
    }

    await finalizePack(metaDbs, ftsDb, manifest, shardWriter.shardId, SHARD_PATH_DIR, CACHE_DIR, stats, partitionCounts, injectMetadata, printBuildSummary);

    // FNI sanity check
    let totalFni = 0, zeroFni = 0, maxFni = 0;
    const allScores = [];
    for (const db of Object.values(metaDbs)) for (const r of db.prepare('SELECT fni_score FROM entities').iterate()) { const s = r.fni_score || 0; if (s === 0) zeroFni++; if (s > maxFni) maxFni = s; allScores.push(s); totalFni++; }
    allScores.sort((a, b) => a - b);
    const median = allScores[Math.floor(allScores.length / 2)] || 0, zeroRatio = totalFni > 0 ? zeroFni / totalFni : 0;
    console.log(`[FNI-CHECK] total=${totalFni} zero=${zeroFni} (${(zeroRatio * 100).toFixed(1)}%) median=${median.toFixed(1)} max=${maxFni.toFixed(1)}`);
    if (zeroRatio > 0.05 || maxFni > 99.9 || median < 10) { console.error('[VFS] BUILD HALTED: FNI sanity check failed.'); process.exit(1); }

    const { exportParquetFromShards, exportLiteParquetFromShards } = await import('./lib/parquet-exporter.js');
    await exportParquetFromShards(metaDbs); await exportLiteParquetFromShards(metaDbs);

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
    const vecShardCache = new Map();
    for (const row of top30k) {
        const eid = row.id || row.slug;
        const si = cachedIdToShard.get(eid) ?? idToShardIdx.get(eid);
        if (si == null) continue;
        if (!vecShardCache.has(si)) vecShardCache.set(si, readEmbeddingShard(EMBED_SHARD_DIR, si) || new Map());
        const vec = vecShardCache.get(si).get(eid);
        if (vec) { const f32 = new Float32Array(VEC_DIM); for (let j = 0; j < VEC_DIM; j++) f32[j] = vec[j] / 127.0; row.embedding = Array.from(f32); }
    }
    vecShardCache.clear();
    const withVec = top30k.filter(r => r.embedding).length;
    console.log(`[VFS] Top-30k vectors: ${withVec}/${top30k.length} from embedding shards`);
    closeCache(cacheDb);
    await generateHotShard(top30k);
    await generateVectorCore(top30k);

    const { buildClusterAnnIndex } = await import('./lib/cluster-ann-builder.js');
    await buildClusterAnnIndex(EMBED_SHARD_DIR);
    const { generateEdgeIndex } = await import('./lib/edge-index-gen.js');
    const { generateMetaAnchors } = await import('./lib/meta-anchors.js');
    await generateEdgeIndex();
    await generateMetaAnchors();

    const { buildInvertedIndexFromShards } = await import('./lib/inverted-index-builder.js');
    await buildInvertedIndexFromShards(metaDbs, path.join(SHARD_PATH_DIR, 'term_index'));
    Object.values(metaDbs).forEach(db => db.close());
    if (global.gc) global.gc();
    console.log('[VFS] V26.7 Streaming Packer Complete (zero accumulator).');
}
packDatabase().catch(err => { console.error('Failure:', err); process.exit(1); });
