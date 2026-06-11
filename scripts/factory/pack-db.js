// V27.0 Streaming Shard-DB Packer — Per-shard embeddings, zero accumulator
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
const fsp = fs;
import { configureDistiller, distillEntity, flushDistillerCache, getDistillerStats } from './lib/v25-distiller.js';
import { cleanAbstract } from './lib/abstract-cleaner.js';
import { loadTrendingMap, loadTrendMap, streamFusedEntities, buildBundleJson, buildEntityRow, setupDatabasePragmas, injectMetadata, printBuildSummary, resetPackOutputDbs, resolveEntitySpecs } from './lib/pack-utils.js';
import { computeMetaShardSlot, assertMetaShardRoutable } from './lib/meta-shard-router.js';
// V27.104: fts.db (standalone FTS5 `search` table) cut. It had ZERO live readers —
// frontend keyword search is the static inverted index (term_index/), not FTS5.
// The full ~450K-row FTS insert + VACUUM every bake was pure wasted compute/storage/warm.
import { dbSchemas } from './lib/pack-schemas.js';
import { getV6Category } from './lib/category-stats-generator.js';
import { generateHotShard } from './lib/hot-shard-generator.js';
import { loadMeshProfileMap } from './lib/mesh-profile-loader.js'; import { normalizeId, getNodeSource } from '../utils/id-normalizer.js'; // D0b canonical key for profile attach
import { generateVectorCore } from './lib/vector-core-generator.js';
import { finalizePack } from './lib/pack-finalizer.js';
import { ShardWriter } from './lib/shard-writer.js';
import { initRustBridge } from './lib/rust-bridge.js';
import { computeEmbeddings } from './lib/embedding-generator.js';
import { openCache, validateModel, closeCache } from './lib/embedding-cache.js';
import { scanAllShardIds, writeEmbeddingShard, readEmbeddingShard } from './lib/embedding-shard-cache.js';
import { createEntityLookupAccess, getEntityLookupSize, finalizeStreamingPack, resolveMeshFixup } from './lib/entity-lookup-cache.js';
import { META_SHARD_COUNT } from '../../src/constants/shard-constants.js';
import { loadHostedOnMap, enrichHostedOn } from './lib/hosted-on-enricher.js';
import { startBatchProf, tickBatch, phaseT } from './lib/pack-profiler.js';
import { recoverTop30k } from './lib/top30k-recovery.js';
import { generateIdIndex } from './lib/id-index-generator.js';
import { deriveBuildId } from './lib/build-id.js';
import { deriveSlug } from './lib/derive-slug.js';

// Cancelled types dropped at pack source (re-pack ages baked rows out): prompt
// (#2141), space (merged->model), agent. mcp-server re-emits type=tool (kept).
const CANCELLED_TYPES = new Set(['prompt', 'space', 'agent']);
const CANCELLED_ID_PREFIXES = ['langchain-prompt--', 'hf-prompt--', 'prompt--', 'hf-space--', 'space--', 'gh-agent--', 'github-agent--', 'hf-agent--', 'replicate-agent--', 'langchain-agent--', 'agent--'];
function isCancelledEntity(e) {
    if (!e) return false;
    if (CANCELLED_TYPES.has(e.type || e.entity_type)) return true;
    const id = String(e.id || e.slug || '').toLowerCase();
    return CANCELLED_ID_PREFIXES.some(p => id.startsWith(p));
}

const CACHE_DIR = process.env.CACHE_DIR || './output/cache', SHARD_PATH_DIR = './output/data';
const THRESHOLD_KB = 0, MAX_SHARD_SIZE = 8 * 1024 * 1024, EMBEDDING_BATCH = 500;
const PACK_STATE_PATH = path.join(CACHE_DIR, 'pack-state.db');
const EMBED_SHARD_DIR = path.join(CACHE_DIR, 'embeddings');
const EMBEDDING_MODEL = 'Xenova/bge-base-en-v1.5';

async function packDatabase() {
    const rustStatus = initRustBridge();
    console.log(`[VFS] Rust FFI: ${rustStatus.mode} (${rustStatus.modules.join(', ') || 'JS fallback'}) | Commencing V26.7 Streaming Packer (zero accumulator)...`);
    assertMetaShardRoutable(); // V27.95: fail loud pre-loop if meta-shard routing can't use xxhash64 (writer==reader)
    // B4 coherence token: ONE build-id captured ONCE, threaded to BOTH the
    // id-index header AND shards_manifest.json (read path proves same-bake).
    const buildId = deriveBuildId();

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

    resetPackOutputDbs(SHARD_PATH_DIR, META_SHARD_COUNT);
    const partitionCounts = { meta_shards: META_SHARD_COUNT };
    const metaDbs = {};
    for (let i = 0; i < META_SHARD_COUNT; i++) {
        metaDbs[`slot_${i}`] = new Database(path.join(SHARD_PATH_DIR, `meta-${String(i).padStart(2, '0')}.db`));
    }
    Object.values(metaDbs).forEach(setupDatabasePragmas);
    Object.values(metaDbs).forEach(db => db.exec(dbSchemas));

    // Derive the placeholder width from the LIVE schema (all metaDbs share dbSchemas),
    // so a column-less `INSERT INTO entities VALUES (...)` always matches the created
    // table. Hardcoding the count silently drifts every time pack-schemas.js gains or
    // drops a column (e.g. #2133 added 11 -> 60 != 71 SqliteError at prepare time).
    const ENTITY_COLS = Object.values(metaDbs)[0]
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('entities')").get().c;
    const placeholder = Array(ENTITY_COLS).fill('?').join(', ');
    const prepInserts = {};
    for (const [key, db] of Object.entries(metaDbs)) prepInserts[key] = db.prepare(`INSERT INTO entities VALUES (${placeholder})`);
    const stats = { packed: 0, heavy: 0, bytes: 0 };
    const manifest = {};
    const shardWriter = new ShardWriter(SHARD_PATH_DIR);
    await shardWriter.init();
    let currentShardName = shardWriter.open();
    const seenUmids = new Set();
    let dupSkipped = 0, cancelledSkipped = 0;  // prompt/space/agent cancelled types

    Object.values(metaDbs).forEach(db => db.exec("BEGIN TRANSACTION"));
    configureDistiller(cacheDb);  // V25.12: pass cacheDb for HTML render cache

    const { map: hostedOnMap, timestamp: hostedOnTs } = loadHostedOnMap(CACHE_DIR);
    const meshProfileMap = await loadMeshProfileMap(CACHE_DIR);  // V27.62: orphan-write fix
    const uncachedByShard = new Map();  // V27.0: per-shard embedding write track

    console.log('[VFS] Single-pass streaming pack...');
    startBatchProf();
    await streamFusedEntities(CACHE_DIR, trendingMap, trendMap, (e, shardIdx) => {
        const umidKey = e.umid || e.id;
        if (seenUmids.has(umidKey)) { dupSkipped++; return; }
        seenUmids.add(umidKey);
        if (isCancelledEntity(e)) { cancelledSkipped++; return; }  // prompt/space/agent
        const eid = e.id || e.slug;

        // V25.12 lookup track. V27.94 (3rd-diag): dropped #2114's e.type arg (its canonical insert was a no-op; e.id already canonical). Real fix is target-side in v25-distiller.js.
        if (eid) lookupAccess.trackEntity(eid, e.name || e.displayName || eid, e.icon || '');
        if (eid && !cachedIdSet.has(eid)) {
            if (!uncachedByShard.has(shardIdx)) uncachedByShard.set(shardIdx, []);
            uncachedByShard.get(shardIdx).push({ id: eid, name: e.name || '', summary: e.summary || e.clean_summary || e.description || '' });
        }

        // D0b: baker-canonical key FIRST (baker:93/171 keys map by normalizeId(id,getNodeSource(id,type),type), not just lowercase). normalizeId/getNodeSource self-guard non-string ids (return null/'') so a bad id can't throw; mirrors baker's bare call. V27.71 lowercase fallbacks kept.
        const mp = meshProfileMap.get(normalizeId(e.id, getNodeSource(e.id, e.type), e.type)) || meshProfileMap.get(e.id) || meshProfileMap.get(e.id?.toLowerCase());
        if (mp) e.mesh_profile = mp;

        const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
        const { pBillions, ctxLen, arch } = resolveEntitySpecs(e);

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

        // V27.46: raise body_content cleanAbstract char limit (500→800) to recover
        // summary for minimal-card entities where description fallback didn't produce content.
        // Final truncation to 500 + ellipsis kept for SQL row size discipline.
        const rawSummary = e.summary || e.description || e.clean_summary || cleanAbstract(e.body_content, 800) || '';
        const truncatedSummary = rawSummary.length > 500 ? rawSummary.substring(0, 500) + '...' : rawSummary;
        const category = getV6Category(e);
        const tags = Array.isArray(e.tags) ? e.tags.join(', ') : (e.tags || '');
        e.search_vector = keywords;
        if (!e.slug && e.id) e.slug = deriveSlug(e.id);

        const metaValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, truncatedSummary, bundleKey, offset, size);
        // Drift guard: fail loud with both counts if row-builders.js and pack-schemas.js
        // go out of sync, instead of the cryptic "N columns but M values supplied" SQLite error.
        if (metaValues.length !== ENTITY_COLS) {
            throw new Error(`[VFS] entity row/column drift: buildEntityRow produced ${metaValues.length} values but the entities table has ${ENTITY_COLS} columns. Re-align row-builders.js with pack-schemas.js entitiesTableSql.`);
        }
        const slotId = computeMetaShardSlot(e.slug || e.id, META_SHARD_COUNT);
        prepInserts[`slot_${slotId}`].run(...metaValues);

        stats.packed++;
        tickBatch(stats.packed);
    });

    cachedIdSet.clear();

    await phaseT('commit-tx', async () => {
        Object.values(metaDbs).forEach(db => db.exec("COMMIT"));
        shardWriter.finalize();
    });
    if (dupSkipped > 0) console.warn(`[VFS] Pack loop skipped ${dupSkipped} duplicate-umid entities`);
    if (cancelledSkipped > 0) console.warn(`[VFS] Pack loop dropped ${cancelledSkipped} prompt/space/agent entities (types cancelled)`);

    // V27.0: Post-pass — compute embeddings per-shard, write binary shards
    const idToShardIdx = new Map();
    const uncachedEntities = [];
    for (const [si, arr] of uncachedByShard) { for (const e of arr) { idToShardIdx.set(e.id, si); uncachedEntities.push(e); } }
    const pendingByShardIdx = new Map();
    await phaseT('finalize-streaming-pack', () => finalizeStreamingPack({
        cacheDb, lookupAccess, uncachedEntities,
        computeEmbeddings, saveBatch: (_db, batch) => {
            for (const item of batch) {
                const si = idToShardIdx.get(item.id) ?? 0;
                if (!pendingByShardIdx.has(si)) pendingByShardIdx.set(si, []);
                pendingByShardIdx.get(si).push(item);
            }
        }, flushDistillerCache, getDistillerStats
    }));

    await phaseT('embedding-shard-write', async () => {
        for (const [si, items] of pendingByShardIdx) {
            const existing = await readEmbeddingShard(EMBED_SHARD_DIR, si) || new Map();
            for (const it of items) { const int8 = new Int8Array(it.embedding.length); for (let i = 0; i < it.embedding.length; i++) int8[i] = Math.max(-128, Math.min(127, Math.round(it.embedding[i] * 127))); existing.set(it.id, Buffer.from(int8.buffer)); }
            await writeEmbeddingShard(EMBED_SHARD_DIR, si, [...existing.entries()].map(([id, vector]) => ({ id, vector })));
        }
        console.log(`[VFS] Wrote ${pendingByShardIdx.size} embedding shards (${uncachedEntities.length} new vectors)`);
    });

    // V25.12: Mesh fix-up — re-resolve forward refs that missed the streaming
    // SQLite proxy during main pass. Runs AFTER lookupAccess.flush so
    // entity_lookup is complete; runs BEFORE finalizePack VACUUM to avoid
    // re-fragmenting the meta DBs.
    await phaseT('mesh-fixup', async () => {
        const meshFix = resolveMeshFixup(cacheDb, metaDbs);
        if (meshFix.rowsUpdated > 0) console.log(`[VFS] Mesh fix-up: ${meshFix.refsResolved} refs re-resolved across ${meshFix.rowsUpdated} entities.`);
    });

    await phaseT('finalize-pack', () => finalizePack(metaDbs, manifest, shardWriter.shardId, SHARD_PATH_DIR, CACHE_DIR, stats, partitionCounts, injectMetadata, printBuildSummary, buildId));

    await phaseT('fni-sanity-check', async () => {
        let totalFni = 0, zeroFni = 0, maxFni = 0;
        const allScores = [];
        for (const db of Object.values(metaDbs)) for (const r of db.prepare('SELECT fni_score FROM entities').iterate()) { const s = r.fni_score || 0; if (s === 0) zeroFni++; if (s > maxFni) maxFni = s; allScores.push(s); totalFni++; }
        allScores.sort((a, b) => a - b);
        const median = allScores[Math.floor(allScores.length / 2)] || 0, zeroRatio = totalFni > 0 ? zeroFni / totalFni : 0;
        console.log(`[FNI-CHECK] total=${totalFni} zero=${zeroFni} (${(zeroRatio * 100).toFixed(1)}%) median=${median.toFixed(1)} max=${maxFni.toFixed(1)}`);
        if (zeroRatio > 0.05 || maxFni > 99.9 || median < 10) { console.error('[VFS] BUILD HALTED: FNI sanity check failed.'); process.exit(1); }
    });

    await phaseT('parquet-export', async () => {
        const { exportParquetFromShards, exportLiteParquetFromShards } = await import('./lib/parquet-exporter.js');
        await exportParquetFromShards(metaDbs); await exportLiteParquetFromShards(metaDbs);
    });

    const top30k = await phaseT('top30k-recovery', () => recoverTop30k(metaDbs, cachedIdToShard, idToShardIdx, EMBED_SHARD_DIR));
    closeCache(cacheDb);
    await phaseT('hot-shard-vector-core', async () => { await generateHotShard(top30k); await generateVectorCore(top30k); });
    await phaseT('cluster-ann-build', async () => {
        const { buildClusterAnnIndex } = await import('./lib/cluster-ann-builder.js');
        await buildClusterAnnIndex(EMBED_SHARD_DIR);
    });
    await phaseT('edge-index-meta-anchors', async () => {
        const { generateEdgeIndex } = await import('./lib/edge-index-gen.js');
        const { generateMetaAnchors } = await import('./lib/meta-anchors.js');
        await generateEdgeIndex();
        await generateMetaAnchors();
    });
    await phaseT('inverted-index', async () => {
        const { buildInvertedIndexFromShards } = await import('./lib/inverted-index-builder.js');
        await buildInvertedIndexFromShards(metaDbs, path.join(SHARD_PATH_DIR, 'term_index'));
    });
    // Read-path P1: full-corpus id->shard warm tier (SAME buildId as finalize-pack).
    await phaseT('id-index', () => generateIdIndex(metaDbs, buildId));
    Object.values(metaDbs).forEach(db => db.close());
    if (global.gc) global.gc();
    console.log('[VFS] V26.7 Streaming Packer Complete (zero accumulator).');
}
packDatabase().catch(err => { console.error('Failure:', err); process.exit(1); });
