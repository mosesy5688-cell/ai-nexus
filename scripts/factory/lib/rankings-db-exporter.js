/**
 * Rankings DB Exporter (V3 §5.0)
 * Writes per-group rankings to standalone SQLite DBs for VFS-compliant SSR consumption.
 * Each DB is a self-contained subset of the meta-NN.db schema — 1 R2 Range Read per type.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const RANKINGS_SCHEMA = `
    CREATE TABLE entities (
        id TEXT PRIMARY KEY, slug TEXT, name TEXT, type TEXT, author TEXT,
        summary TEXT, fni_score REAL, pipeline_tag TEXT, license TEXT,
        vram_estimate_gb REAL, params_billions REAL, context_length INTEGER DEFAULT 0,
        stars INTEGER DEFAULT 0, downloads INTEGER DEFAULT 0, raw_pop REAL DEFAULT 0,
        fni_s REAL DEFAULT 0, fni_a REAL DEFAULT 0, fni_p REAL DEFAULT 0,
        fni_r REAL DEFAULT 0, fni_q REAL DEFAULT 0,
        bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER,
        last_modified TEXT, category TEXT, architecture TEXT,
        task_categories TEXT, forks INTEGER DEFAULT 0, citation_count INTEGER DEFAULT 0
    );
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_fni ON entities(fni_score DESC);
    CREATE INDEX idx_type ON entities(type);
    CREATE INDEX idx_pipeline ON entities(pipeline_tag);
`;

const INSERT_SQL = `INSERT OR IGNORE INTO entities (
    id, slug, name, type, author, summary, fni_score, pipeline_tag, license,
    vram_estimate_gb, params_billions, context_length, stars, downloads, raw_pop,
    fni_s, fni_a, fni_p, fni_r, fni_q,
    bundle_key, bundle_offset, bundle_size, last_modified, category, architecture,
    task_categories, forks, citation_count
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export async function exportRankingsDbs(groups, outputDir) {
    const dataDir = path.join(outputDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    let totalDbs = 0;

    for (const [groupName, entities] of Object.entries(groups)) {
        if (!entities.length) continue;
        const dbPath = path.join(dataDir, `rankings-${groupName}.db`);
        const db = new Database(dbPath);
        db.pragma('journal_mode = OFF');
        db.pragma('synchronous = OFF');
        db.exec(RANKINGS_SCHEMA);
        const insert = db.prepare(INSERT_SQL);
        db.exec('BEGIN');
        for (const e of entities) {
            insert.run(
                e.id, e.slug || '', e.name || e.slug || '', e.type || 'model',
                e.author || '', (e.description || e.summary || '').substring(0, 500),
                e.fni_score || e.fni || 0, e.pipeline_tag || '', e.license || '',
                e.vram_estimate_gb || 0, e.params_billions ?? 0, e.context_length ?? 0,
                e.stars || 0, e.downloads || 0, e.raw_pop || 0,
                e.fni_s ?? 50.0, e.fni_a ?? 0, e.fni_p ?? 0, e.fni_r ?? 0, e.fni_q ?? 0,
                e.bundle_key || '', e.bundle_offset ?? 0, e.bundle_size ?? 0,
                e.last_modified || '', e.category || '', e.architecture || '',
                e.task_categories || '', e.forks || 0, e.citation_count || 0
            );
        }
        db.exec('COMMIT');
        const metaInsert = db.prepare('INSERT INTO site_metadata (key, value) VALUES (?, ?)');
        metaInsert.run('rankings_group', groupName);
        metaInsert.run('entity_count', String(entities.length));
        metaInsert.run('generated', new Date().toISOString());
        db.exec('VACUUM');
        db.close();
        const sizeMb = (fs.statSync(dbPath).size / 1048576).toFixed(2);
        console.log(`  [RANKINGS-DB] ${groupName}: ${entities.length} entities → ${sizeMb}MB`);
        totalDbs++;
    }
    console.log(`[RANKINGS-DB] Exported ${totalDbs} ranking databases to ${dataDir}`);
}
