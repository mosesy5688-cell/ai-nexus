/**
 * V25.8 Dedup Manager - Master Ledger Authority
 *
 * Manages `dedup.db` — the persistent master SQLite ledger on R2.
 * Ensures zero-deletion via SQL UPSERT on UMID.
 * New entities are appended; existing entities are enriched.
 *
 * Tracks `last_refresh_at` for the Evergreen Refresh Protocol.
 */

import Database from 'better-sqlite3';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { setupDatabasePragmas } from './pack-utils.js';
import { generateUMID } from './umid-generator.js';

const DEDUP_DB_PATH = process.env.DEDUP_DB_PATH || './output/data/dedup.db';

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

/**
 * Open or create the dedup ledger. Applies schema migration for has_fulltext.
 */
export function openLedger(dbPath = DEDUP_DB_PATH) {
    const dir = path.dirname(dbPath);
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });

    const db = new Database(dbPath);
    setupDatabasePragmas(db, { vfsPageSize: false });
    db.exec(DEDUP_SCHEMA);

    // V25.8.3: Migrate existing DBs — add has_fulltext if missing
    const cols = db.pragma('table_info(ledger)').map(c => c.name);
    if (!cols.includes('has_fulltext')) {
        db.exec('ALTER TABLE ledger ADD COLUMN has_fulltext INTEGER DEFAULT 0');
        db.exec('CREATE INDEX IF NOT EXISTS idx_enrichment ON ledger(type, has_fulltext) WHERE status = \'active\'');
    }
    return db;
}

/**
 * Upsert entities into the master ledger.
 * New records are inserted; existing records are refreshed (never deleted).
 *
 * @param {Array} entities - Entity array
 * @param {string} dbPath - Path to dedup.db
 * @returns {{ inserted: number, refreshed: number, total: number }}
 */
export function upsertEntities(entities, dbPath = DEDUP_DB_PATH) {
    const db = openLedger(dbPath);
    const now = new Date().toISOString();

    // V25.9.6: has_fulltext propagated from search.db (fusion-authoritative).
    // MAX(old, new) semantics — once enriched, never regress to 0 (defensive against
    // transient R2/enrichment-file outages where fusion might fail to detect fulltext).
    const upsert = db.prepare(`
        INSERT INTO ledger (umid, canonical_id, type, source, name, author, first_seen_at, last_refresh_at, refresh_count, fni_score, has_fulltext, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active')
        ON CONFLICT(canonical_id) DO UPDATE SET
            umid = excluded.umid,
            last_refresh_at = excluded.last_refresh_at,
            refresh_count = refresh_count + 1,
            fni_score = excluded.fni_score,
            name = COALESCE(excluded.name, name),
            author = COALESCE(excluded.author, author),
            has_fulltext = MAX(has_fulltext, excluded.has_fulltext),
            status = 'active'
    `);

    let inserted = 0, refreshed = 0;

    db.exec('BEGIN TRANSACTION');

    for (const entity of entities) {
        const id = entity.id || entity.slug;
        if (!id) continue;

        const umid = entity.umid || generateUMID(id);
        const author = Array.isArray(entity.author) ? entity.author.join(', ') : (entity.author || '');

        const changes = upsert.run(
            umid, id, entity.type || 'model', entity.source || '',
            entity.name || '', author, now, now,
            entity.fni_score || 0,
            entity.has_fulltext ? 1 : 0
        );

        if (changes.changes > 0) {
            // Check if it was an insert or update
            const existing = db.prepare('SELECT refresh_count FROM ledger WHERE umid = ?').get(umid);
            if (existing && existing.refresh_count === 0) inserted++;
            else refreshed++;
        }
    }

    db.exec('COMMIT');

    const total = db.prepare('SELECT COUNT(*) as c FROM ledger').get().c;
    db.close();

    console.log(`[DEDUP] Ledger updated: +${inserted} new, ~${refreshed} refreshed, ${total} total`);
    return { inserted, refreshed, total };
}

/**
 * Get the oldest entities that need refreshing (Evergreen Protocol).
 * @param {number} limit - Number of entities to return
 * @param {string} dbPath - Path to dedup.db
 * @returns {Array} Entities needing refresh (oldest first)
 */
export function getRefreshCandidates(limit = 15000, dbPath = DEDUP_DB_PATH) {
    const db = openLedger(dbPath);
    const candidates = db.prepare(`
        SELECT umid, canonical_id, type, source, last_refresh_at, refresh_count
        FROM ledger
        WHERE status = 'active'
        ORDER BY last_refresh_at ASC
        LIMIT ?
    `).all(limit);
    db.close();
    return candidates;
}

/**
 * V25.8.3→V25.9: Get entities needing fulltext enrichment (Density Booster queue).
 * Filters by UMID hex prefix range for partition-parallel workers.
 * @param {string} prefixStart - Hex prefix start (e.g. '00')
 * @param {string} prefixEnd - Hex prefix end (e.g. '0f')
 * @param {number} limit - Max entities to return
 * @param {string} dbPath - Path to dedup.db
 * @param {string[]} types - Entity types to enrich (default: paper only — models get README at 1/4 harvest)
 * @returns {Array<{umid: string, canonical_id: string, source: string, type: string}>}
 */
export function getEnrichmentQueue(prefixStart, prefixEnd, limit = 5000, dbPath = DEDUP_DB_PATH, types = ['paper']) {
    const db = openLedger(dbPath);
    const placeholders = types.map(() => '?').join(',');
    const queue = db.prepare(`
        SELECT umid, canonical_id, source, type
        FROM ledger
        WHERE type IN (${placeholders}) AND has_fulltext = 0 AND status = 'active'
          AND umid >= ? AND umid < ?
        ORDER BY fni_score DESC
        LIMIT ?
    `).all(...types, prefixStart, prefixEnd + 'g', limit);
    db.close();
    console.log(`[DEDUP] Enrichment queue: ${queue.length} entities (${types.join(',')}) in [${prefixStart}..${prefixEnd}]`);
    return queue;
}

/**
 * V25.8.3: Mark UMIDs as enriched (has_fulltext = 1).
 * @param {string[]} umids - Array of enriched UMIDs
 * @param {string} dbPath - Path to dedup.db
 */
export function markEnriched(umids, dbPath = DEDUP_DB_PATH) {
    if (!umids.length) return;
    const db = openLedger(dbPath);
    const stmt = db.prepare('UPDATE ledger SET has_fulltext = 1 WHERE umid = ?');
    db.exec('BEGIN TRANSACTION');
    for (const umid of umids) stmt.run(umid);
    db.exec('COMMIT');
    db.close();
    console.log(`[DEDUP] Marked ${umids.length} UMIDs as enriched`);
}

/**
 * Verify ledger parity against entity count.
 * @param {number} expectedMin - Minimum expected count
 * @param {string} dbPath - Path to dedup.db
 * @returns {boolean} True if parity check passes
 */
export function verifyParity(expectedMin, dbPath = DEDUP_DB_PATH) {
    const db = openLedger(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM ledger WHERE status = ?').get('active').c;
    db.close();

    const pass = count >= expectedMin;
    console.log(`[DEDUP] Parity check: ${count} active (min: ${expectedMin}) -> ${pass ? 'PASS' : 'FAIL'}`);
    return pass;
}

if (process.argv[1]?.endsWith('dedup-manager.js')) {
    console.log('[DEDUP] Standalone mode: Creating empty ledger...');
    const db = openLedger();
    const count = db.prepare('SELECT COUNT(*) as c FROM ledger').get().c;
    console.log(`[DEDUP] Ledger has ${count} entries.`);
    db.close();
}
