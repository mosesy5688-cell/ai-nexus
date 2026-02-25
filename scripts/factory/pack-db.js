/**
 * V19.2 Sharded Binary DB Packer (Stable 1.0 Ratified)
 * Architecture: Modular (CES Compliant)
 */

import Database from 'better-sqlite3';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { loadTrendingMap, loadTrendMap, collectAndSortMetadata, buildBundleJson, buildEntityRow } from './lib/pack-utils.js';
import { getV6Category } from './lib/category-stats-generator.js';

const CACHE_DIR = process.env.CACHE_DIR || './output/cache';
const META_DB_PATH = './output/data/meta.db';
const SEARCH_DB_PATH = './output/data/search.db';
const SHARD_PATH_DIR = './output/data';
const THRESHOLD_KB = 50;
const MAX_SHARD_SIZE = 256 * 1024 * 1024;

async function packDatabase() {
    console.log('[VFS] 💎 Commencing Constitutional Split-DB V22.0 Packing...');

    await fs.mkdir(SHARD_PATH_DIR, { recursive: true });

    // Cleanup old DBs
    if (await fs.stat(META_DB_PATH).catch(() => null)) await fs.unlink(META_DB_PATH);
    if (await fs.stat(SEARCH_DB_PATH).catch(() => null)) await fs.unlink(SEARCH_DB_PATH);

    const trendingMap = await loadTrendingMap(CACHE_DIR);
    const trendMap = await loadTrendMap(CACHE_DIR);
    const metadataBatch = await collectAndSortMetadata(CACHE_DIR, trendingMap, trendMap);

    // Initialize Databases
    const metaDb = new Database(META_DB_PATH);
    const searchDb = new Database(SEARCH_DB_PATH);

    const setupDb = (db) => {
        db.pragma('page_size = 8192'); // V22.0 High-Density 8K Alignment
        db.pragma('auto_vacuum = 0');
        db.pragma('journal_mode = DELETE');
        db.pragma('synchronous = OFF');
        db.pragma('encoding = "UTF-8"');
    };

    setupDb(metaDb);
    setupDb(searchDb);

    // Schema A: meta.db (Search Index - Contentless FTS5 per Const. 5.1)
    // V22.8: Added license, source_url, pipeline_tag, image_url, vram_estimate_gb, source
    const metaSchema = `
        CREATE TABLE entities (
            id TEXT PRIMARY KEY, umid TEXT UNIQUE, slug TEXT, name TEXT, type TEXT, author TEXT, summary TEXT, 
            category TEXT, tags TEXT, fni_score REAL, fni_percentile TEXT,
            fni_p REAL DEFAULT 0, fni_v REAL DEFAULT 0, fni_c REAL DEFAULT 0, fni_u REAL DEFAULT 0,
            params_billions REAL DEFAULT 0,
            architecture TEXT,
            context_length INTEGER DEFAULT 0,
            is_trending INTEGER DEFAULT 0, stars INTEGER, downloads INTEGER, 
            last_modified TEXT, bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER, shard_hash TEXT, trend_7d TEXT,
            license TEXT DEFAULT '', source_url TEXT DEFAULT '', pipeline_tag TEXT DEFAULT '',
            image_url TEXT DEFAULT '', vram_estimate_gb REAL DEFAULT 0, source TEXT DEFAULT ''
        );
        -- V22.6: Strictly Contentless FTS5 (content='')
        CREATE VIRTUAL TABLE search USING fts5(name, summary, author, tags, category, content='', tokenize='unicode61 remove_diacritics 2');
        CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
        CREATE INDEX idx_fni ON entities(fni_score DESC);
        CREATE INDEX idx_type ON entities(type);
    `;

    // Schema B: search.db (Full Registry - Lossless)
    // V22.8: Added license, source_url, pipeline_tag, image_url, vram_estimate_gb, source
    const searchSchema = `
        CREATE TABLE entities (
            id TEXT PRIMARY KEY, umid TEXT UNIQUE, slug TEXT, name TEXT, type TEXT, author TEXT, summary TEXT, 
            category TEXT, tags TEXT, fni_score REAL, fni_percentile TEXT,
            fni_p REAL DEFAULT 0, fni_v REAL DEFAULT 0, fni_c REAL DEFAULT 0, fni_u REAL DEFAULT 0,
            params_billions REAL DEFAULT 0,
            architecture TEXT,
            context_length INTEGER DEFAULT 0,
            is_trending INTEGER DEFAULT 0, stars INTEGER, downloads INTEGER, 
            last_modified TEXT, bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER, shard_hash TEXT, trend_7d TEXT,
            license TEXT DEFAULT '', source_url TEXT DEFAULT '', pipeline_tag TEXT DEFAULT '',
            image_url TEXT DEFAULT '', vram_estimate_gb REAL DEFAULT 0, source TEXT DEFAULT ''
        );
        CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
        CREATE INDEX idx_fni_full ON entities(fni_score DESC);
    `;

    metaDb.exec(metaSchema);
    searchDb.exec(searchSchema);

    // V22.8: 27 original + 6 new = 33 columns
    const insertEntityMeta = metaDb.prepare(`INSERT INTO entities VALUES (${',?'.repeat(33).slice(1)})`);
    const insertEntitySearch = searchDb.prepare(`INSERT INTO entities VALUES (${',?'.repeat(33).slice(1)})`);
    // V22.6: FTS5 strictly contentless requires rowid mapping
    const updateFts = metaDb.prepare(`INSERT INTO search (rowid, name, summary, author, tags, category) VALUES (?, ?, ?, ?, ?, ?)`);

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

    metaDb.transaction(() => {
        searchDb.transaction(() => {
            let rowId = 1;
            for (const e of metadataBatch) {
                const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
                const pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0;
                const ctxLen = e.context_length ?? e.technical?.context_length ?? 0;
                const arch = e.architecture ?? e.technical?.architecture ?? '';

                const bundleJson = buildBundleJson(e, fniMetrics, pBillions, ctxLen, arch);

                let bundleKey = null, offset = 0, size = 0;
                if (bundleJson.length > THRESHOLD_KB * 1024) {
                    const padding = (8192 - (currentShardSize % 8192)) % 8192;
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

                const rawSummary = e.summary || e.description || '';
                const truncatedSummary = rawSummary.length > 500 ? rawSummary.substring(0, 500) + '...' : rawSummary;
                const category = getV6Category(e);
                const tags = Array.isArray(e.tags) ? e.tags.join(', ') : (e.tags || '');

                const metaValues = buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, truncatedSummary, bundleKey, offset, size);
                const searchValues = [...metaValues];
                searchValues[6] = rawSummary; // Lossless summary for search.db

                insertEntityMeta.run(...metaValues);
                insertEntitySearch.run(...searchValues);
                // V22.6: INSERT into contentless search table using rowid alignment
                updateFts.run(rowId++, e.name || '', truncatedSummary, e.author || '', tags, category);
                stats.packed++;
            }
        })();
    });

    if (currentFd) fsSync.closeSync(currentFd);

    // Finalize Shard Hashes in meta.db
    for (let i = 0; i <= currentShardId; i++) {
        const name = `fused-shard-${String(i).padStart(3, '0')}.bin`;
        const file = path.join(SHARD_PATH_DIR, name);
        if (fsSync.existsSync(file)) {
            const hash = crypto.createHash('sha256').update(fsSync.readFileSync(file)).digest('hex');
            manifest[`data/${name}`] = hash;
            metaDb.prepare('UPDATE entities SET shard_hash = ? WHERE bundle_key = ?').run(hash, `data/${name}`);
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
                metaDb.prepare('INSERT OR REPLACE INTO site_metadata (key, value) VALUES (?, ?)').run(meta.key, content);
                searchDb.prepare('INSERT OR REPLACE INTO site_metadata (key, value) VALUES (?, ?)').run(meta.key, content);
            }
        } catch (e) { }
    }

    await fs.writeFile(path.join(SHARD_PATH_DIR, 'shards_manifest.json'), JSON.stringify(manifest));

    // Finalization
    searchDb.exec("INSERT INTO search(search) VALUES('optimize');");
    metaDb.exec("PRAGMA integrity_check; VACUUM;");
    searchDb.exec("PRAGMA integrity_check; VACUUM;");

    metaDb.close();
    searchDb.close();
    console.log(`[VFS] ✅ Constitutional Split-DB Complete! Shards: ${currentShardId + 1}, Heavy: ${stats.heavy}`);
}

packDatabase().catch(err => { console.error('❌ Failure:', err); process.exit(1); });
