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
        status TEXT DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_refresh ON ledger(last_refresh_at ASC);
    CREATE INDEX IF NOT EXISTS idx_type ON ledger(type);
    CREATE INDEX IF NOT EXISTS idx_status ON ledger(status);
`;

/**
 * Open or create the dedup ledger.
 */
export function openLedger(dbPath = DEDUP_DB_PATH) {
    const dir = path.dirname(dbPath);
    const fsSync = require('fs');
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });

    const db = new Database(dbPath);
    setupDatabasePragmas(db);
    db.exec(DEDUP_SCHEMA);
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

    const upsert = db.prepare(`
        INSERT INTO ledger (umid, canonical_id, type, source, name, author, first_seen_at, last_refresh_at, refresh_count, fni_score, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active')
        ON CONFLICT(umid) DO UPDATE SET
            last_refresh_at = excluded.last_refresh_at,
            refresh_count = refresh_count + 1,
            fni_score = excluded.fni_score,
            name = COALESCE(excluded.name, name),
            author = COALESCE(excluded.author, author),
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
            entity.fni_score || 0
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
