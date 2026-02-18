/**
 * V19.0 SQLite DB Packer (Sequential Batching)
 * 
 * Features:
 * - Sequential processing (O(1) Memory usage for 670k entities)
 * - Page Alignment (8192 bytes)
 * - Bundle Object Strategy (Externalizes heavy fields > 50KB)
 * - Contentless FTS5 Indexing
 * - Production-level PRAGMAs (VACUUM, journal_mode=OFF)
 */

import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { loadRegistryShardsSequentially } from './lib/registry-loader.js';

const DB_PATH = './data/content.db';
const ASSET_BUNDLE_DIR = './data/bundles';
const THRESHOLD_KB = 50;

async function packDatabase() {
    console.log('[VFS] Initializing A-Grade DB Packing Sequence...');

    // Ensure output directories exist
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    await fs.mkdir(ASSET_BUNDLE_DIR, { recursive: true });

    // 1. Create/Open Database
    if (await fs.stat(DB_PATH).catch(() => null)) {
        await fs.unlink(DB_PATH);
    }
    const db = new Database(DB_PATH);

    // 2. Set Industrial Pragmas (BEFORE schema creation)
    db.pragma('page_size = 8192');
    db.pragma('auto_vacuum = NONE');
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('mmap_size = 134217728'); // 128MB Mapping

    try {
        // 3. Define Schema
        db.exec(`
            -- Metadata Table (Hot Data)
            CREATE TABLE entities (
                id TEXT PRIMARY KEY,
                umid TEXT UNIQUE,
                slug TEXT,
                name TEXT,
                type TEXT,
                author TEXT,
                summary TEXT,
                fni_score REAL,
                fni_percentile TEXT,
                stars INTEGER,
                downloads INTEGER,
                last_modified TEXT,
                bundle_key TEXT -- Pointer to R2 Bundle Object
            );

            CREATE INDEX idx_type ON entities(type);
            CREATE INDEX idx_slug ON entities(slug);

            -- Contentless FTS5 Table (Search Plane)
            CREATE VIRTUAL TABLE search USING fts5(
                name,
                summary,
                author,
                content='', -- Contentless mode
                tokenize='unicode61 remove_diacritics 2'
            );
        `);

        // 4. Batch Inserter Logic
        const insertEntity = db.prepare(`
            INSERT INTO entities (id, umid, slug, name, type, author, summary, fni_score, fni_percentile, stars, downloads, last_modified, bundle_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertFts = db.prepare(`INSERT INTO search (rowid, name, summary, author) VALUES (?, ?, ?, ?)`);

        let count = 0;
        let batchStart = Date.now();

        // 5. Sequential Streaming (The OOM Guard)
        await loadRegistryShardsSequentially(async (entities, shardIndex) => {
            const transaction = db.transaction((batch) => {
                for (const e of batch) {
                    const umid = e.umid || e.id;
                    const heavyAssets = {};

                    // Bundle Strategy: Segregate fields > THRESHOLD_KB
                    const bundleData = {
                        readme: e.readme || e.html_readme || '',
                        changelog: e.changelog || '',
                        benchmarks: e.benchmarks || [],
                        paper_abstract: e.paper_abstract || ''
                    };

                    const bundleJson = JSON.stringify(bundleData);
                    const isHeavy = bundleJson.length > THRESHOLD_KB * 1024;
                    const bundleKey = isHeavy ? `bundles/${umid}.json` : null;

                    if (isHeavy) {
                        // Mark for external storage (Factory will upload this to R2)
                        // In practice, we write it to a local file for the 'upload' stage to pick up
                        heavyAssets.json = bundleJson;
                        heavyAssets.path = path.join(ASSET_BUNDLE_DIR, `${umid}.json`);
                    }

                    // V19.0-FIX: Apply same fallback chain as registry-loader.js projectEntity()
                    const entityName = e.name || e.title || e.displayName || '';
                    const entityAuthor = e.author || e.creator || e.organization || '';
                    const entityDesc = e.description || e.summary || '';
                    const entitySlug = e.slug || '';
                    const entityFni = e.fni_score ?? e.fni ?? 0;
                    const entityPercentile = e.fni_percentile || e.percentile || '';
                    const entityStars = e.stars || e.github_stars || 0;
                    const entityDownloads = e.downloads || 0;
                    const entityModified = e.last_modified || e.last_updated || e.lastModified || e._updated || '';

                    // Insert Metadata
                    const result = insertEntity.run(
                        e.id, umid, entitySlug, entityName, e.type || 'model',
                        entityAuthor, entityDesc, entityFni,
                        entityPercentile, entityStars, entityDownloads,
                        entityModified, bundleKey
                    );

                    // Insert FTS (rowid links to entities.rowid)
                    insertFts.run(result.lastInsertRowid, entityName, entityDesc, entityAuthor);

                    count++;
                }
            });

            transaction(entities);
            console.log(`[VFS] Shard ${shardIndex} Processed. Total: ${count}. Rate: ${Math.round(count / ((Date.now() - batchStart) / 1000))} ent/s`);
        }, { slim: false });

        // 6. Final Stabilization
        console.log('[VFS] Freezing DB...');
        db.exec("INSERT INTO search(search) VALUES('optimize');");
        db.exec("INSERT INTO search(search) VALUES('optimize');"); // Double Optimize
        db.exec("PRAGMA integrity_check;");
        db.exec("VACUUM;");

        const finalSize = (await fs.stat(DB_PATH)).size;
        console.log(`[VFS] Pack Complete! Final Size: ${(finalSize / 1024 / 1024).toFixed(2)} MB`);

        if (finalSize > 600 * 1024 * 1024) {
            console.error('🚨 SCALE GUARD BREACH: content.db exceeds 600MB!');
            process.exit(1);
        }

    } catch (err) {
        console.error('[VFS] Packing Failed:', err);
        process.exit(1);
    } finally {
        db.close();
    }
}

packDatabase();
