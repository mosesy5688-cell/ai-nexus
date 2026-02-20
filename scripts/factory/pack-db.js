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
import { loadTrendingMap, loadTrendMap, collectAndSortMetadata } from './lib/pack-utils.js';
import { getV6Category } from './lib/category-stats-generator.js';

const CACHE_DIR = process.env.CACHE_DIR || './output/cache';
const DB_PATH = './output/data/content.db';
const SHARD_PATH_DIR = './output/data';
const THRESHOLD_KB = 50;
const MAX_SHARD_SIZE = 256 * 1024 * 1024;

async function packDatabase() {
    console.log('[VFS] 💎 Commencing Stable 1.0 DB Packing (Modular)...');

    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    if (await fs.stat(DB_PATH).catch(() => null)) await fs.unlink(DB_PATH);

    const trendingMap = await loadTrendingMap(CACHE_DIR);
    const trendMap = await loadTrendMap(CACHE_DIR);
    const metadataBatch = await collectAndSortMetadata(CACHE_DIR, trendingMap, trendMap);

    const db = new Database(DB_PATH);
    db.pragma('page_size = 4096');
    db.pragma('auto_vacuum = 0');
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = OFF');
    db.pragma('encoding = "UTF-8"');

    db.exec(`
        CREATE TABLE entities (
            id TEXT PRIMARY KEY, umid TEXT UNIQUE, slug TEXT, name TEXT, type TEXT, author TEXT, summary TEXT, 
            category TEXT, fni_score REAL, fni_percentile TEXT,
            fni_p REAL DEFAULT 0, fni_v REAL DEFAULT 0, fni_c REAL DEFAULT 0, fni_u REAL DEFAULT 0,
            params_billions REAL DEFAULT 0,
            architecture TEXT,
            context_length INTEGER DEFAULT 0,
            is_trending INTEGER DEFAULT 0, stars INTEGER, downloads INTEGER, 
            last_modified TEXT, bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER, shard_hash TEXT, trend_7d TEXT
        );
        CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
        CREATE INDEX idx_fni ON entities(fni_score DESC);
        CREATE VIRTUAL TABLE search USING fts5(name, summary, author, content='', tokenize='unicode61 remove_diacritics 2');
    `);

    // V19.2: 26 columns in Stable 1.0 schema
    const insertEntity = db.prepare(`INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = db.prepare(`INSERT INTO search (rowid, name, summary, author) VALUES (?, ?, ?, ?)`);

    let currentShardId = 0, currentShardSize = 0;
    const stats = { packed: 0, heavy: 0, bytes: 0 };
    const shardHashes = new Map();
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

    db.transaction(() => {
        for (const e of metadataBatch) {
            // V19.5: Data Parity Expansion
            const fniMetrics = e.fni_metrics || e.fni?.metrics || {};
            const pBillions = e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0;
            const ctxLen = e.context_length ?? e.technical?.context_length ?? 0;
            const arch = e.architecture ?? e.technical?.architecture ?? '';

            const bundleJson = Buffer.from(JSON.stringify({
                readme: e.readme || e.html_readme || '',
                changelog: e.changelog || '',
                benchmarks: e.benchmarks || [],
                paper_abstract: e.paper_abstract || '',
                mesh_profile: e.mesh_profile || { relations: [] },
                // V19.5: Included for Engine 1 Detail Page completeness
                fni_metrics: fniMetrics,
                params_billions: pBillions,
                context_length: ctxLen,
                architecture: arch
            }), 'utf8');

            let bundleKey = null, offset = 0, size = 0;
            if (bundleJson.length > THRESHOLD_KB * 1024) {
                // Security Choice B: 8KB Alignment (SPEC-V19.2)
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

            const category = getV6Category(e);

            const res = insertEntity.run(
                e.id, e.umid || e.id, e.slug || '', e.name || e.displayName || '', e.type || 'model',
                e.author || '', e.summary || '', category, e.fni_score || 0, e.fni_percentile || '',
                e.fni_p ?? fniMetrics.p ?? 0, e.fni_v ?? fniMetrics.v ?? 0,
                e.fni_c ?? fniMetrics.c ?? 0, e.fni_u ?? fniMetrics.u ?? 0,
                pBillions,
                arch,
                ctxLen,
                e.is_trending ? 1 : 0,
                e.stars || 0, e.downloads || 0, e.last_modified || '', bundleKey, offset, size,
                '', // shard_hash (filled in final pass)
                e._trend_7d
            );
            insertFts.run(res.lastInsertRowid, e.name || '', e.summary || '', e.author || '');
            stats.packed++;
        }
    })();

    if (currentFd) fsSync.closeSync(currentFd);

    for (let i = 0; i <= currentShardId; i++) {
        const name = `fused-shard-${String(i).padStart(3, '0')}.bin`;
        const file = path.join(SHARD_PATH_DIR, name);
        if (fsSync.existsSync(file)) {
            const hash = crypto.createHash('sha256').update(fsSync.readFileSync(file)).digest('hex');
            manifest[`data/${name}`] = hash;
            db.prepare('UPDATE entities SET shard_hash = ? WHERE bundle_key = ?').run(hash, `data/${name}`);
        }
    }

    // V19.3: Inject Global Site Metadata (Stats/Rankings/Trending/Relations)
    console.log('[VFS] 🌐 Injecting Global Site Metadata (V19.3)...');
    const injectMeta = db.prepare('INSERT OR REPLACE INTO site_metadata (key, value) VALUES (?, ?)');
    const metaFiles = [
        { key: 'category_stats', file: 'category_stats.json' },
        { key: 'trending', file: 'trending.json' },
        { key: 'relations', file: 'relations/explicit.json' },
        { key: 'knowledge_links', file: 'relations/knowledge-links.json' }
    ];

    for (const meta of metaFiles) {
        try {
            const possiblePaths = [
                path.join(CACHE_DIR, meta.file),
                path.join(CACHE_DIR, `${meta.file}.gz`),
                path.join(path.dirname(CACHE_DIR), meta.file),
                path.join(path.dirname(CACHE_DIR), `${meta.file}.gz`)
            ];

            let content = null;
            for (const p of possiblePaths) {
                try {
                    const raw = await fs.readFile(p);
                    content = (p.endsWith('.gz') || (raw[0] === 0x1f && raw[1] === 0x8b))
                        ? zlib.gunzipSync(raw).toString('utf-8')
                        : raw.toString('utf-8');
                    break;
                } catch (err) { continue; }
            }

            if (content) {
                injectMeta.run(meta.key, content);
                console.log(`  - Injected: ${meta.key} (${Math.round(content.length / 1024)} KB)`);
            } else {
                console.warn(`  - Missing: ${meta.key}`);
            }
        } catch (e) {
            console.warn(`  - Failed to inject ${meta.key}:`, e.message);
        }
    }

    await fs.writeFile(path.join(SHARD_PATH_DIR, 'shards_manifest.json'), JSON.stringify(manifest));
    db.exec("INSERT INTO search(search) VALUES('optimize'); PRAGMA integrity_check; VACUUM;");
    db.close();
    console.log(`[VFS] ✅ Packing Complete! Total: ${stats.packed}, Heavy: ${stats.heavy}, Shards: ${currentShardId + 1}`);
}

packDatabase().catch(err => { console.error('❌ Failure:', err); process.exit(1); });
