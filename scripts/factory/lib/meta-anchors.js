/**
 * V25.8 Meta Anchors Generator
 *
 * Creates meta-report.db and meta-knowledge.db as First-Class
 * VFS categories for AI Content Authority (Discovery Anchors).
 *
 * These databases enable instant listing of AI reports and
 * knowledge articles alongside entity catalogs.
 */

import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { setupDatabasePragmas } from './pack-utils.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output/data';
const CACHE_DIR = process.env.CACHE_DIR || './output/cache';

const ANCHOR_SCHEMA = `
    CREATE TABLE articles (
        id TEXT PRIMARY KEY,
        umid TEXT UNIQUE,
        title TEXT,
        subtitle TEXT,
        summary TEXT,
        category TEXT,
        tags TEXT,
        author TEXT DEFAULT 'free2aitools',
        published_at TEXT,
        updated_at TEXT,
        slug TEXT,
        word_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'published',
        canonical_url TEXT,
        citation TEXT
    );
    CREATE INDEX idx_published ON articles(published_at DESC);
    CREATE INDEX idx_category ON articles(category);
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * Build meta-report.db from daily report cache
 */
async function buildReportDb() {
    const dbPath = path.join(OUTPUT_DIR, 'meta-report.db');
    const db = new Database(dbPath);
    setupDatabasePragmas(db);
    db.exec(ANCHOR_SCHEMA);

    const insert = db.prepare(`INSERT OR REPLACE INTO articles VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`);

    let count = 0;
    const reportsDir = path.join(CACHE_DIR, 'reports');

    try {
        const files = await fs.readdir(reportsDir);
        db.exec('BEGIN TRANSACTION');

        for (const file of files.filter(f => f.endsWith('.json') || f.endsWith('.json.gz'))) {
            try {
                const raw = await fs.readFile(path.join(reportsDir, file));
                const report = file.endsWith('.gz')
                    ? JSON.parse(zlib.gunzipSync(raw))
                    : JSON.parse(raw);

                const id = report.id || `report-${file.replace(/\.(json|json\.gz)$/, '')}`;
                const slug = id.replace(/[^a-z0-9-]/g, '-');

                insert.run(
                    id, report.umid || '', report.title || '', report.subtitle || '',
                    report.summary || '', 'daily-report', report.tags || '',
                    report.author || 'free2aitools', report.published_at || report.date || '',
                    report.updated_at || '', slug, report.word_count || 0,
                    'published',
                    `https://free2aitools.com/reports/${slug}`,
                    ''
                );
                count++;
            } catch (e) {
                // Skip invalid files silently
            }
        }

        db.exec('COMMIT');
    } catch {
        console.warn('[META-ANCHORS] No reports directory found. Creating empty meta-report.db.');
    }

    db.exec('PRAGMA integrity_check; VACUUM;');
    db.close();
    console.log(`[META-ANCHORS] meta-report.db: ${count} reports indexed`);
}

/**
 * Build meta-knowledge.db from knowledge articles
 */
async function buildKnowledgeDb() {
    const dbPath = path.join(OUTPUT_DIR, 'meta-knowledge.db');
    const db = new Database(dbPath);
    setupDatabasePragmas(db);
    db.exec(ANCHOR_SCHEMA);

    let count = 0;
    const knowledgeDir = path.join(CACHE_DIR, 'knowledge');

    const insert = db.prepare(`INSERT OR REPLACE INTO articles VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`);

    try {
        const files = await fs.readdir(knowledgeDir);
        db.exec('BEGIN TRANSACTION');

        for (const file of files.filter(f => f.endsWith('.json') || f.endsWith('.json.gz'))) {
            try {
                const raw = await fs.readFile(path.join(knowledgeDir, file));
                const article = file.endsWith('.gz')
                    ? JSON.parse(zlib.gunzipSync(raw))
                    : JSON.parse(raw);

                const id = article.id || article.slug || file.replace(/\.(json|json\.gz)$/, '');
                const slug = id.replace(/[^a-z0-9-]/g, '-');

                insert.run(
                    id, article.umid || '', article.title || '', article.subtitle || '',
                    article.summary || article.content || '', article.category || 'knowledge',
                    Array.isArray(article.tags) ? article.tags.join(', ') : (article.tags || ''),
                    article.author || 'free2aitools',
                    article.published_at || article.date || '', article.updated_at || '',
                    slug, article.word_count || 0, 'published',
                    `https://free2aitools.com/knowledge/${slug}`,
                    ''
                );
                count++;
            } catch (e) {
                // Skip invalid files
            }
        }

        db.exec('COMMIT');
    } catch {
        console.warn('[META-ANCHORS] No knowledge directory found. Creating empty meta-knowledge.db.');
    }

    db.exec('PRAGMA integrity_check; VACUUM;');
    db.close();
    console.log(`[META-ANCHORS] meta-knowledge.db: ${count} articles indexed`);
}

export async function generateMetaAnchors() {
    console.log('[META-ANCHORS] Building Discovery Anchor databases...');
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await buildReportDb();
    await buildKnowledgeDb();
    console.log('[META-ANCHORS] Complete.');
}

if (process.argv[1]?.endsWith('meta-anchors.js')) {
    generateMetaAnchors().catch(err => {
        console.error('[META-ANCHORS] Fatal:', err);
        process.exit(1);
    });
}
