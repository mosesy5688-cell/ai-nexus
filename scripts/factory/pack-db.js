/**
 * V23.1 Sharded Binary DB Packer (Serverless Search Engine)
 * Architecture: Modular (CES Compliant) Hash-Shard DBs
 */

import Database from 'better-sqlite3';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { configureDistiller, distillEntity } from './lib/v25-distiller.js';
import {
    loadTrendingMap, loadTrendMap, collectAndSortMetadata,
    buildBundleJson, buildEntityRow, getShardIndex,
    setupDatabasePragmas, injectMetadata, printBuildSummary
} from './lib/pack-utils.js';
import { dbSchemas, searchDbSchema } from './lib/pack-schemas.js';
import { getV6Category } from './lib/category-stats-generator.js';
import { generateHotShard } from './lib/hot-shard-generator.js';
import { generateVectorCore } from './lib/vector-core-generator.js';

const CACHE_DIR = process.env.CACHE_DIR || './output/cache', SEARCH_DB_PATH = './output/data/search.db', SHARD_PATH_DIR = './output/data';
const THRESHOLD_KB = 0, MAX_SHARD_SIZE = 256 * 1024 * 1024;

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

    // Universal Shard Calculation (Shard-DB 4.0)
    const typeGroups = {};
    metadataBatch.forEach(e => {
        const type = e.type || 'model';
        if (!typeGroups[type]) typeGroups[type] = [];
        typeGroups[type].push(e);
    });

    const partitionCounts = {};
    const SHARD_TARGET_BYTES = 75 * 1024 * 1024; // ~75MB raw JSON per shard

    for (const [type, entities] of Object.entries(typeGroups)) {
        if (type === 'model') {
            const nonTrending = entities.filter(e => !e.is_trending);
            // Core takes first 50k, sharding applies after that
            const modelShardBytes = nonTrending.slice(50000).reduce((sum, e) => sum + JSON.stringify(e).length, 0);
            partitionCounts.model = Math.max(1, Math.ceil(modelShardBytes / SHARD_TARGET_BYTES));
        } else {
            const totalBytes = entities.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
            partitionCounts[type] = Math.max(1, Math.ceil(totalBytes / SHARD_TARGET_BYTES));
        }
    }

    console.log('[VFS] Universal Routing Table:');
    Object.entries(partitionCounts).forEach(([type, count]) => {
        console.log(`  - ${type.padEnd(12)}: ${count} shard(s)`);
    });

    const metaDbs = { core: new Database(path.join(SHARD_PATH_DIR, 'meta-model-core.db')) };

    // Dynamically initialize DBs for all types/shards
    for (const [type, count] of Object.entries(partitionCounts)) {
        if (type === 'model') {
            for (let i = 1; i <= count; i++) {
                metaDbs[`model_shard_${i}`] = new Database(path.join(SHARD_PATH_DIR, `meta-model-shard-${String(i).padStart(2, '0')}.db`));
            }
        } else {
            for (let i = 1; i <= count; i++) {
                const name = count === 1 ? `meta-${type}.db` : `meta-${type}-shard-${String(i).padStart(2, '0')}.db`;
                metaDbs[`${type}_shard_${i}`] = new Database(path.join(SHARD_PATH_DIR, name));
            }
        }
    }

    const searchDb = new Database(SEARCH_DB_PATH);

    Object.values(metaDbs).forEach(setupDatabasePragmas);
    setupDatabasePragmas(searchDb);

    Object.values(metaDbs).forEach(db => db.exec(dbSchemas));
    searchDb.exec(searchDbSchema);

    // Prepare Statements
    const placeholder = Array(38).fill('?').join(', ');
    const prepInserts = {}, prepFts = {};

    for (const [key, db] of Object.entries(metaDbs)) {
        prepInserts[key] = db.prepare(`INSERT INTO entities VALUES (${placeholder})`);
        prepFts[key] = db.prepare(`INSERT INTO search (rowid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?)`);
    }
    const insertEntitySearch = searchDb.prepare(`INSERT INTO entities VALUES (${placeholder})`);

    let currentShardId = 0, currentShardSize = 0;
    const stats = { packed: 0, heavy: 0, bytes: 0 };
    const manifest = {};

    let currentFd = null;
    const openShard = () => {
        if (currentShardId >= 64) { console.error('❌ Shard limit exceeded'); process.exit(1); }
        if (currentFd) fsSync.closeSync(currentFd);
        const name = `fused-shard-${String(currentShardId).padStart(3, '0')}.bin`;
        const fullPath = path.join(SHARD_PATH_DIR, name);
        currentFd = fsSync.openSync(fullPath, 'w');
        currentShardSize = 0;
        return name;
    };

    let currentShardName = openShard();

    Object.values(metaDbs).forEach(db => db.exec("BEGIN TRANSACTION"));
    searchDb.exec("BEGIN TRANSACTION");

    let rowIds = {};
    Object.keys(metaDbs).forEach(k => rowIds[k] = 1);

    let modelCoreCount = 0;

    // V25.1 Compute Shift-Left: Initialize Distiller
    configureDistiller();

    const entityLookup = new Map();
    metadataBatch.forEach(e => {
        entityLookup.set(e.id || e.slug, {
            name: e.name || e.displayName || (e.id || e.slug),
            icon: e.icon || '📦'
        });
    });

    for (const e of metadataBatch) {
        const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
        const pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0;
        const ctxLen = e.context_length ?? e.technical?.context_length ?? 0;
        const arch = e.architecture ?? e.technical?.architecture ?? '';

        // V25.1 Distillation Pipeline
        e = distillEntity(e, pBillions, entityLookup);

        const bundleJson = buildBundleJson(e, fniMetrics, pBillions, ctxLen, arch);
        let bundleKey = null, offset = 0, size = 0;
        if (bundleJson.length > THRESHOLD_KB * 1024) {
            const padding = (16384 - (currentShardSize % 16384)) % 16384;
            if (padding > 0) {
                fsSync.writeSync(currentFd, Buffer.alloc(padding, 0));
                currentShardSize += padding;
            }
            if (currentShardSize + bundleJson.length > MAX_SHARD_SIZE) {
                currentShardId++;
                currentShardName = openShard();
            }
            bundleKey = `data/${currentShardName}`; offset = currentShardSize; size = bundleJson.length;
            fsSync.writeSync(currentFd, bundleJson);
            currentShardSize += size;
            stats.heavy++; stats.bytes += size;
        }

        const rawSummary = e.summary || e.description || e.body_content || '';
        const truncatedSummary = rawSummary.length > 500 ? rawSummary.substring(0, 500) + '...' : rawSummary;
        const category = getV6Category(e);
        const tags = Array.isArray(e.tags) ? e.tags.join(', ') : (e.tags || '');

        const metaValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, truncatedSummary, bundleKey, offset, size);
        const searchValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, rawSummary, bundleKey, offset, size);

        // Universal Routing Logic (Shard-DB 4.0)
        let type = e.type || 'model';
        let targetKey = '';

        if (type === 'model') {
            if (e.is_trending || modelCoreCount < 50000) {
                targetKey = 'core';
                modelCoreCount++;
            } else {
                targetKey = `model_shard_${getShardIndex(e.slug || e.id, partitionCounts.model)}`;
            }
        } else {
            const shardIdx = getShardIndex(e.slug || e.id, partitionCounts[type]);
            targetKey = `${type}_shard_${shardIdx}`;
        }

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
        stats.packed++;
    }

    Object.values(metaDbs).forEach(db => db.exec("COMMIT"));
    searchDb.exec("COMMIT");
    if (currentFd) fsSync.closeSync(currentFd);

    // ── V22.9/V22.10: Generation ─────────
    generateHotShard(metadataBatch);
    generateVectorCore(metadataBatch);

    // Finalize Shard Hashes
    console.log('[VFS] 🌐 Updating shard hashes...');
    for (let i = 0; i <= currentShardId; i++) {
        const name = `fused-shard-${String(i).padStart(3, '0')}.bin`;
        const file = path.join(SHARD_PATH_DIR, name);
        if (fsSync.existsSync(file)) {
            const hash = crypto.createHash('sha256').update(fsSync.readFileSync(file)).digest('hex');
            manifest[`data/${name}`] = hash;
            Object.values(metaDbs).forEach(db => {
                db.prepare('UPDATE entities SET shard_hash = ? WHERE bundle_key = ?').run(hash, `data/${name}`);
            });
        }
    }

    await injectMetadata(metaDbs, searchDb, CACHE_DIR);
    const fullManifest = { shards: manifest, partitions: partitionCounts };
    await fs.writeFile(path.join(SHARD_PATH_DIR, 'shards_manifest.json'), JSON.stringify(fullManifest, null, 2));

    printBuildSummary(metaDbs, searchDb, stats, currentShardId);

    // Finalization
    console.log('[VFS] 🌐 Optimizing databases...');
    Object.values(metaDbs).forEach(db => {
        db.exec("INSERT INTO search(search) VALUES('optimize');");
        db.exec("PRAGMA integrity_check; VACUUM;");
        db.close();
    });

    searchDb.exec("PRAGMA integrity_check; VACUUM;");
    searchDb.close();

    console.log(`[VFS] ✅ V23.1 Shard-DB Packing Complete.`);
}

packDatabase().catch(err => { console.error('❌ Failure:', err); process.exit(1); });
