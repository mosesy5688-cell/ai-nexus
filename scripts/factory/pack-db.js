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
import { loadTrendingMap, loadTrendMap, collectAndSortMetadata, buildBundleJson, buildEntityRow, cyrb53, getModelShardIndex } from './lib/pack-utils.js';
import { dbSchemas, searchDbSchema } from './lib/pack-schemas.js';
import { getV6Category } from './lib/category-stats-generator.js';
import { persistRegistry } from './lib/aggregator-persistence.js';
import { generateHotShard } from './lib/hot-shard-generator.js';
import { generateVectorCore } from './lib/vector-core-generator.js';

const CACHE_DIR = process.env.CACHE_DIR || './output/cache';
const SEARCH_DB_PATH = './output/data/search.db';
const SHARD_PATH_DIR = './output/data';
const THRESHOLD_KB = 0; // V22.8: Universal Sharding
const MAX_SHARD_SIZE = 256 * 1024 * 1024;



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

    // Initialize Databases
    const metaDbs = {
        core: new Database(path.join(SHARD_PATH_DIR, 'meta-model-core.db')),
        shard1: new Database(path.join(SHARD_PATH_DIR, 'meta-model-shard-01.db')),
        shard2: new Database(path.join(SHARD_PATH_DIR, 'meta-model-shard-02.db')),
        shard3: new Database(path.join(SHARD_PATH_DIR, 'meta-model-shard-03.db')),
        shard4: new Database(path.join(SHARD_PATH_DIR, 'meta-model-shard-04.db')),
        shard5: new Database(path.join(SHARD_PATH_DIR, 'meta-model-shard-05.db')),
        dataset: new Database(path.join(SHARD_PATH_DIR, 'meta-dataset.db')),
        paper: new Database(path.join(SHARD_PATH_DIR, 'meta-paper.db')),
        ecosystem: new Database(path.join(SHARD_PATH_DIR, 'meta-ecosystem.db')),
    };

    // Legacy full DB
    const searchDb = new Database(SEARCH_DB_PATH);

    const setupDb = (db) => {
        db.pragma('page_size = 16384'); // V23.1 High-Density 16K Alignment for fewer R2 requests
        db.pragma('auto_vacuum = 0');
        db.pragma('journal_mode = DELETE');
        db.pragma('synchronous = OFF');
        db.pragma('encoding = "UTF-8"');
    };

    Object.values(metaDbs).forEach(setupDb);
    setupDb(searchDb);



    Object.values(metaDbs).forEach(db => db.exec(dbSchemas));


    searchDb.exec(searchDbSchema);

    // Prepare Statements
    const placeholder = Array(33).fill('?').join(', ');
    const prepInserts = {};
    const prepFts = {};

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

    let rowIds = {
        core: 1, shard1: 1, shard2: 1, shard3: 1, shard4: 1, shard5: 1,
        dataset: 1, paper: 1, ecosystem: 1
    };

    let modelCoreCount = 0;

    for (const e of metadataBatch) {
        const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
        const pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0;
        const ctxLen = e.context_length ?? e.technical?.context_length ?? 0;
        const arch = e.architecture ?? e.technical?.architecture ?? '';

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

        // Routing Logic
        let targetKey = 'ecosystem';
        if (e.type === 'dataset') {
            targetKey = 'dataset';
        } else if (e.type === 'paper') {
            targetKey = 'paper';
        } else if (e.type === 'model' || !e.type) {
            if (e.is_trending || modelCoreCount < 50000) {
                targetKey = 'core';
                modelCoreCount++;
            } else {
                const sIdx = getModelShardIndex(e.slug || e.id || e.name || '');
                targetKey = `shard${sIdx}`;
            }
        }

        prepInserts[targetKey].run(...metaValues);
        insertEntitySearch.run(...searchValues);

        const ftsValues = [
            rowIds[targetKey]++,
            String(e.name || e.displayName || ''),
            String(truncatedSummary),
            Array.isArray(e.author) ? e.author.join(', ') : String(e.author || ''),
            String(tags),
            String(category)
        ];
        prepFts[targetKey].run(...ftsValues);

        stats.packed++;
    }

    Object.values(metaDbs).forEach(db => db.exec("COMMIT"));
    searchDb.exec("COMMIT");

    if (currentFd) fsSync.closeSync(currentFd);

    // ── V22.9: Generate Hot Shard (Top 50K Zero-Copy Binary) ─────────
    generateHotShard(metadataBatch);

    // ── V22.10: Generate Vector Core (Tier 3 Semantic Engine) ─────────
    generateVectorCore(metadataBatch);

    // Finalize Shard Hashes in all DBs
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

    // Inject Metadata into BOTH databases
    console.log('[VFS] 🌐 Injecting Global Metadata...');
    const metaFiles = [
        { key: 'category_stats', file: 'category_stats.json' },
        { key: 'trending', file: 'trending.json' },
        { key: 'relations', file: 'relations/explicit.json' },
        { key: 'knowledge_links', file: 'relations/knowledge-links.json' }
    ];

    for (const meta of metaFiles) {
        try {
            const possiblePaths = [path.join(CACHE_DIR, meta.file), path.join(CACHE_DIR, `${meta.file}.gz`)];
            let content = null;
            for (const p of possiblePaths) {
                try {
                    const raw = await fs.readFile(p);
                    content = (p.endsWith('.gz') || (raw[0] === 0x1f && raw[1] === 0x8b)) ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
                    break;
                } catch (err) { continue; }
            }
            if (content) {
                Object.values(metaDbs).forEach(db => {
                    db.prepare('INSERT OR REPLACE INTO site_metadata (key, value) VALUES (?, ?)').run(meta.key, content);
                });
                searchDb.prepare('INSERT OR REPLACE INTO site_metadata (key, value) VALUES (?, ?)').run(meta.key, content);
            }
        } catch (e) { }
    }

    await fs.writeFile(path.join(SHARD_PATH_DIR, 'shards_manifest.json'), JSON.stringify(manifest));

    // Finalization
    console.log('[VFS] 🌐 Optimizing databases...');
    Object.values(metaDbs).forEach(db => {
        db.exec("INSERT INTO search(search) VALUES('optimize');");
        db.exec("PRAGMA integrity_check; VACUUM;");
        db.close();
    });

    searchDb.exec("PRAGMA integrity_check; VACUUM;");
    searchDb.close();

    console.log(`[VFS] ✅ V23.1 Shard-DB Complete! Shards: ${currentShardId + 1}, Models in Core: ${modelCoreCount}`);
}

packDatabase().catch(err => { console.error('❌ Failure:', err); process.exit(1); });
