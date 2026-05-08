/**
 * V26.6 Dedup Manager — Sharded Master Ledger
 *
 * Manages dedup ledger as 16 SQLite shards (shard-0.db to shard-f.db).
 * Shard key = first hex character of UMID.
 * Zero-deletion via SQL UPSERT on canonical_id.
 */

import Database from 'better-sqlite3';
import fsSync from 'fs';
import path from 'path';
import { setupDatabasePragmas } from './pack-utils.js';
import { generateUMID } from './umid-generator.js';

const DEDUP_DIR = process.env.DEDUP_DB_PATH
    ? path.dirname(process.env.DEDUP_DB_PATH)
    : (process.env.DEDUP_DIR || './output/data/dedup');
const LEGACY_PATH = process.env.DEDUP_DB_PATH || './output/data/dedup.db';
const SHARD_COUNT = 16;

const DEDUP_SCHEMA = `
    CREATE TABLE IF NOT EXISTS ledger (
        umid TEXT PRIMARY KEY,
        canonical_id TEXT UNIQUE,
        type TEXT,
        source TEXT,
        name TEXT,
        author TEXT,
        first_seen_at TEXT,
        last_refresh_at TEXT,
        refresh_count INTEGER DEFAULT 0,
        fni_score REAL DEFAULT 0,
        has_fulltext INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_refresh ON ledger(last_refresh_at ASC);
    CREATE INDEX IF NOT EXISTS idx_type ON ledger(type);
    CREATE INDEX IF NOT EXISTS idx_status ON ledger(status);
    CREATE INDEX IF NOT EXISTS idx_enrichment ON ledger(type, has_fulltext) WHERE status = 'active';
`;

function shardIndex(umid) { return parseInt(umid[0], 16); }

function shardPath(idx) { return path.join(DEDUP_DIR, `shard-${idx.toString(16)}.db`); }

function shardPathForUmid(umid) { return shardPath(shardIndex(umid)); }

function ensureDir() {
    if (!fsSync.existsSync(DEDUP_DIR)) fsSync.mkdirSync(DEDUP_DIR, { recursive: true });
}

function openShard(idx) {
    ensureDir();
    const db = new Database(shardPath(idx));
    setupDatabasePragmas(db, { vfsPageSize: false });
    db.exec(DEDUP_SCHEMA);
    const cols = db.pragma('table_info(ledger)').map(c => c.name);
    if (!cols.includes('has_fulltext')) {
        db.exec('ALTER TABLE ledger ADD COLUMN has_fulltext INTEGER DEFAULT 0');
        db.exec("CREATE INDEX IF NOT EXISTS idx_enrichment ON ledger(type, has_fulltext) WHERE status = 'active'");
    }
    return db;
}

export function openLedger(dbPath) {
    if (dbPath && dbPath !== LEGACY_PATH) {
        ensureDir();
        const db = new Database(dbPath);
        setupDatabasePragmas(db, { vfsPageSize: false });
        db.exec(DEDUP_SCHEMA);
        return db;
    }
    return openShard(0);
}

export function upsertEntities(entities, _dbPath) {
    const now = new Date().toISOString();
    const groups = new Map();
    for (const entity of entities) {
        const id = entity.id || entity.slug;
        if (!id) continue;
        const umid = entity.umid || generateUMID(id);
        const idx = shardIndex(umid);
        if (!groups.has(idx)) groups.set(idx, []);
        groups.get(idx).push({ ...entity, umid });
    }

    let inserted = 0, refreshed = 0, total = 0;
    for (const [idx, batch] of groups) {
        const db = openShard(idx);
        const upsert = db.prepare(`
            INSERT INTO ledger (umid, canonical_id, type, source, name, author, first_seen_at, last_refresh_at, refresh_count, fni_score, has_fulltext, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active')
            ON CONFLICT(canonical_id) DO UPDATE SET
                umid = excluded.umid, last_refresh_at = excluded.last_refresh_at,
                refresh_count = refresh_count + 1, fni_score = excluded.fni_score,
                name = COALESCE(excluded.name, name), author = COALESCE(excluded.author, author),
                has_fulltext = MAX(has_fulltext, excluded.has_fulltext), status = 'active'
        `);
        db.exec('BEGIN TRANSACTION');
        for (const e of batch) {
            const author = Array.isArray(e.author) ? e.author.join(', ') : (e.author || '');
            const changes = upsert.run(
                e.umid, e.id || e.slug, e.type || 'model', e.source || '',
                e.name || '', author, now, now, e.fni_score || 0, e.has_fulltext ? 1 : 0
            );
            if (changes.changes > 0) {
                const row = db.prepare('SELECT refresh_count FROM ledger WHERE umid = ?').get(e.umid);
                if (row && row.refresh_count === 0) inserted++;
                else refreshed++;
            }
        }
        db.exec('COMMIT');
        total += db.prepare('SELECT COUNT(*) as c FROM ledger').get().c;
        db.close();
    }
    console.log(`[DEDUP] Ledger updated: +${inserted} new, ~${refreshed} refreshed, ${total} total`);
    return { inserted, refreshed, total };
}

export function getEnrichmentQueue(prefixStart, prefixEnd, limit = 5000, _dbPath, types = ['paper']) {
    const startIdx = parseInt(prefixStart[0], 16);
    const endIdx = parseInt(prefixEnd[0], 16);
    const allResults = [];
    for (let idx = startIdx; idx <= endIdx && allResults.length < limit; idx++) {
        const dbFile = shardPath(idx);
        if (!fsSync.existsSync(dbFile)) continue;
        const db = openShard(idx);
        const placeholders = types.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT umid, canonical_id, source, type FROM ledger
            WHERE type IN (${placeholders}) AND has_fulltext = 0 AND status = 'active'
              AND umid >= ? AND umid < ?
            ORDER BY fni_score DESC LIMIT ?
        `).all(...types, prefixStart, prefixEnd + 'g', limit - allResults.length);
        db.close();
        allResults.push(...rows);
    }
    console.log(`[DEDUP] Enrichment queue: ${allResults.length} entities (${types.join(',')}) in [${prefixStart}..${prefixEnd}]`);
    return allResults;
}

export function markEnriched(umids, _dbPath) {
    if (!umids.length) return;
    const groups = new Map();
    for (const umid of umids) {
        const idx = shardIndex(umid);
        if (!groups.has(idx)) groups.set(idx, []);
        groups.get(idx).push(umid);
    }
    let total = 0;
    for (const [idx, batch] of groups) {
        const db = openShard(idx);
        const stmt = db.prepare('UPDATE ledger SET has_fulltext = 1 WHERE umid = ?');
        db.exec('BEGIN TRANSACTION');
        for (const umid of batch) stmt.run(umid);
        db.exec('COMMIT');
        db.close();
        total += batch.length;
    }
    console.log(`[DEDUP] Marked ${total} UMIDs as enriched`);
}

export function getRefreshCandidates(limit = 15000) {
    const all = [];
    for (let i = 0; i < SHARD_COUNT && all.length < limit; i++) {
        if (!fsSync.existsSync(shardPath(i))) continue;
        const db = openShard(i);
        const rows = db.prepare(`SELECT umid, canonical_id, type, source, last_refresh_at, refresh_count
            FROM ledger WHERE status = 'active' ORDER BY last_refresh_at ASC LIMIT ?`).all(limit - all.length);
        db.close();
        all.push(...rows);
    }
    return all;
}

export function aggregateStats() {
    let totalActive = 0, enriched = 0;
    const needByType = {};
    for (let i = 0; i < SHARD_COUNT; i++) {
        if (!fsSync.existsSync(shardPath(i))) continue;
        const db = openShard(i);
        totalActive += db.prepare("SELECT COUNT(*) as c FROM ledger WHERE status='active'").get().c;
        enriched += db.prepare("SELECT COUNT(*) as c FROM ledger WHERE has_fulltext=1 AND status='active'").get().c;
        const rows = db.prepare("SELECT type, COUNT(*) as c FROM ledger WHERE has_fulltext=0 AND status='active' AND type='paper' GROUP BY type").all();
        for (const r of rows) needByType[r.type] = (needByType[r.type] || 0) + r.c;
        db.close();
    }
    return { totalActive, enriched, needByType };
}

export function verifyParity(expectedMin) {
    const { totalActive } = aggregateStats();
    const pass = totalActive >= expectedMin;
    console.log(`[DEDUP] Parity check: ${totalActive} active (min: ${expectedMin}) -> ${pass ? 'PASS' : 'FAIL'}`);
    return pass;
}

export function migrateLegacyToShards() {
    if (!fsSync.existsSync(LEGACY_PATH)) return false;
    console.log(`[DEDUP] Migrating legacy dedup.db → 16 shards...`);
    ensureDir();
    const legacy = new Database(LEGACY_PATH, { readonly: true });
    const count = legacy.prepare('SELECT COUNT(*) as c FROM ledger').get().c;
    let migrated = 0;
    const shardDbs = new Map();
    const getDb = (idx) => { if (!shardDbs.has(idx)) { const d = openShard(idx); d.exec('BEGIN'); shardDbs.set(idx, d); } return shardDbs.get(idx); };
    for (const row of legacy.prepare('SELECT * FROM ledger').iterate()) {
        const idx = shardIndex(row.umid);
        const db = getDb(idx);
        db.prepare(`INSERT OR IGNORE INTO ledger (umid,canonical_id,type,source,name,author,first_seen_at,last_refresh_at,refresh_count,fni_score,has_fulltext,status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            row.umid, row.canonical_id, row.type, row.source, row.name, row.author,
            row.first_seen_at, row.last_refresh_at, row.refresh_count, row.fni_score, row.has_fulltext, row.status
        );
        migrated++;
        if (migrated % 50000 === 0) console.log(`[DEDUP]   Migrated: ${migrated}/${count}`);
    }
    for (const [, db] of shardDbs) { db.exec('COMMIT'); db.close(); }
    legacy.close();
    console.log(`[DEDUP] Migration complete: ${migrated} entities → 16 shards`);
    return true;
}

if (process.argv[1]?.endsWith('dedup-manager.js')) {
    if (process.argv[2] === 'migrate') {
        migrateLegacyToShards();
    } else {
        const stats = aggregateStats();
        console.log(`[DEDUP] ${stats.totalActive} active, ${stats.enriched} enriched`);
    }
}
