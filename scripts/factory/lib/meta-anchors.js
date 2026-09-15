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
import { autoDecompress } from './zstd-helper.js';
import { setupDatabasePragmas } from './pack-utils.js';
import { generateDailyReportsIndex } from './daily-reports-index.js';
import { isKnowledgeJsonFile, knowledgeArticleIdentity } from './knowledge-anchor-identity.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output/data';
const CACHE_DIR = process.env.CACHE_DIR || './output/cache';

const ANCHOR_SCHEMA = `
    CREATE TABLE articles (
        id TEXT PRIMARY KEY,
        -- UNIQUE here means the bind matters: SQLite holds NULLs mutually
        -- distinct, but '' is a value, so two ''-bound rows collide and
        -- INSERT OR REPLACE then deletes the earlier one, leaving one row.
        -- Bind null, not ''; rowCount() refers back to this note. The NULL
        -- side is pinned by meta-anchors-row-identity.test.ts (A3).
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
        citation TEXT,
        content TEXT,
        highlights_json TEXT
    );
    CREATE INDEX idx_published ON articles(published_at DESC);
    CREATE INDEX idx_category ON articles(category);
    CREATE INDEX idx_slug ON articles(slug);
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * Rows that survived into `articles`. Completed insert.run calls are an upper
 * bound on this, by the INSERT OR REPLACE mechanism noted on ANCHOR_SCHEMA's
 * umid column; counting them instead printed "3 articles indexed" over a
 * 1-row table. Both builders log the two under separate names.
 */
function rowCount(db) {
    return db.prepare('SELECT COUNT(*) AS c FROM articles').get().c;
}

/**
 * Build meta-report.db from daily report cache.
 *
 * Exported so the row-count invariant can be asserted against this producer
 * directly. generateMetaAnchors() is not a usable entry point for that: it
 * first runs generateDailyReportsIndex(), which fetches from cdn.free2aitools.com.
 */
export async function buildReportDb() {
    const dbPath = path.join(OUTPUT_DIR, 'meta-report.db');
    const db = new Database(dbPath);
    setupDatabasePragmas(db);
    db.exec(ANCHOR_SCHEMA);

    const insert = db.prepare(`INSERT OR REPLACE INTO articles VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`);

    let completedInserts = 0;  // AFTER insert.run returns: completed, not attempts
    let failed = 0;            // the candidate threw inside the try; cause not recorded
    const reportsDir = path.join(CACHE_DIR, 'reports');
    const dailySubDir = path.join(reportsDir, 'daily');
    const srcDailyDir = path.join(path.dirname(CACHE_DIR), 'daily');
    // V26.13: Also scan fused report files from Master Fusion (report--YYYY-MM-DD.json.zst)
    const fusedDir = path.join(CACHE_DIR, 'fused');
    const dirsToScan = [reportsDir, dailySubDir, srcDailyDir, fusedDir];
    const seenIds = new Set();

    db.exec('BEGIN TRANSACTION');
    for (const dir of dirsToScan) {
        try {
            const files = await fs.readdir(dir);
            // V26.13: In fused dir, only pick report--*.json.zst files
            const isReportFile = (f) => {
                if (dir === fusedDir) return f.startsWith('report--') && (f.endsWith('.json') || f.endsWith('.json.gz') || f.endsWith('.json.zst'));
                return f.endsWith('.json') || f.endsWith('.json.gz') || f.endsWith('.json.zst');
            };
            for (const file of files.filter(isReportFile)) {
                try {
                    const raw = await fs.readFile(path.join(dir, file));
                    const report = JSON.parse((await autoDecompress(raw)).toString('utf-8'));
                    const id = report.id || `report-${file.replace(/\.(json|json\.gz|json\.zst)$/, '')}`;
                    if (seenIds.has(id)) continue;
                    seenIds.add(id);
                    const slug = id.replace(/[^a-z0-9-]/g, '-');
                    insert.run(
                        id, report.umid || null, report.title || '', report.subtitle || '',
                        report.summary || '', 'daily-report', report.tags || '',
                        report.author || 'free2aitools', report.published_at || report.date || '',
                        report.updated_at || '', slug, report.word_count || 0,
                        'published', `https://free2aitools.com/reports/${slug}`, '',
                        report.content || '', report.highlights ? JSON.stringify(report.highlights) : ''
                    );
                    completedInserts++;
                } catch { failed++; /* threw inside the try; cause not recorded */ }
            }
        } catch { /* dir not found — skip */ }
    }
    // Insert trends summary as a special article
    try {
        const trendsPath = path.join(CACHE_DIR, 'trends-summary.json.zst');
        const raw = await fs.readFile(trendsPath);
        const trends = JSON.parse((await autoDecompress(raw)).toString('utf-8'));
        insert.run(
            `trends-${trends.week}`, null, trends.week, 'FNI Pulse Weekly Trends',
            `Top risers and fallers for week ${trends.week}`, 'trends', '',
            'free2aitools', trends.generated || '', '', trends.week, 0,
            'published', `https://free2aitools.com/trends`, '',
            JSON.stringify(trends), JSON.stringify(trends.top_risers || [])
        );
        completedInserts++;
        console.log(`[META-ANCHORS] Trends summary ${trends.week} inserted`);
    } catch (e) { console.warn(`[META-ANCHORS] Trends summary not available: ${e.message}`); }

    db.exec('COMMIT');
    const rows = rowCount(db);
    if (rows === 0) console.warn('[META-ANCHORS] No report rows written from any scan directory.');

    db.exec('PRAGMA integrity_check; VACUUM;');
    db.close();
    console.log(`[META-ANCHORS] meta-report.db: ${rows} row(s) in articles, `
        + `${completedInserts} insert.run call(s) completed, `
        + `${failed} candidate(s) failed during processing`);
}

/**
 * Build meta-knowledge.db from knowledge articles
 */
export async function buildKnowledgeDb() {
    const dbPath = path.join(OUTPUT_DIR, 'meta-knowledge.db');
    const db = new Database(dbPath);
    setupDatabasePragmas(db);
    db.exec(ANCHOR_SCHEMA);

    let completedInserts = 0;  // AFTER insert.run returns: completed, not attempts
    let notArticle = 0;        // the identity gate declined the candidate
    let failed = 0;            // the candidate threw inside the try -- see the catch
    const knowledgeDir = path.join(CACHE_DIR, 'knowledge');

    const insert = db.prepare(`INSERT OR REPLACE INTO articles VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`);

    try {
        // V26.13: Recursive scan — knowledge articles live in subdirectories (ai/, articles/, etc.)
        const files = await fs.readdir(knowledgeDir, { recursive: true });
        db.exec('BEGIN TRANSACTION');

        // Admission gate — see knowledge-anchor-identity.js. This directory also
        // holds the knowledge generator's own `index`/`stats` artifacts, their
        // smart-writer `.v-N` rotations and `.meta.json` checksum sidecars. Only
        // real article payloads may become published /knowledge/<slug> rows,
        // because every row here is served as an existing page by the sitemap,
        // the /knowledge hub and /api/v1/concepts. (V26.12 excluded the `.meta`
        // sidecars only, which left `stats.json.zst` publishing a 404 URL.)
        for (const file of files.filter(isKnowledgeJsonFile)) {
            try {
                const raw = await fs.readFile(path.join(knowledgeDir, file));
                const article = JSON.parse((await autoDecompress(raw)).toString('utf-8'));

                const identity = knowledgeArticleIdentity(file, article);
                if (!identity) { notArticle++; continue; }
                const { id, slug } = identity;

                insert.run(
                    id, article.umid || null, article.title || '', article.subtitle || '',
                    article.summary || '', article.category || 'knowledge',
                    Array.isArray(article.tags) ? article.tags.join(', ') : (article.tags || ''),
                    article.author || 'free2aitools',
                    article.published_at || article.date || '', article.updated_at || '',
                    slug, article.word_count || 0, 'published',
                    `https://free2aitools.com/knowledge/${slug}`, '',
                    article.content || '', ''
                );
                completedInserts++;
            } catch (e) {
                // Separate from notArticle, the gate's explicit "not an article"
                // decision. This bucket is whatever THREW inside the try, and the
                // try opens at fs.readFile -- before knowledgeArticleIdentity()
                // runs. A candidate lands here either pre-gate -- e.g. a directory
                // named *.json (isKnowledgeJsonFile tests the name only, so
                // readFile throws EISDIR), a .gz payload (autoDecompress rejects
                // gzip by design), a malformed body -- or post-gate, when the
                // driver refuses a bind. That split is exhaustive; the causes
                // listed are examples. The counter records neither, so it must
                // not claim which occurred, or that an article was lost.
                failed++;
            }
        }

        db.exec('COMMIT');
    } catch {
        console.warn('[META-ANCHORS] No knowledge directory found. Creating empty meta-knowledge.db.');
    }

    const rows = rowCount(db);
    db.exec('PRAGMA integrity_check; VACUUM;');
    db.close();
    console.log(`[META-ANCHORS] meta-knowledge.db: ${rows} row(s) in articles, `
        + `${completedInserts} insert.run call(s) completed, `
        + `${notArticle} non-article candidate(s) excluded by the identity gate, `
        + `${failed} candidate(s) failed during processing`);
}

export async function generateMetaAnchors() {
    console.log('[META-ANCHORS] Building Discovery Anchor databases...');
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    // V26.10: Sync daily reports → cache/reports/ before building meta-report.db
    try { await generateDailyReportsIndex(path.dirname(CACHE_DIR)); } catch (e) {
        console.warn(`[META-ANCHORS] Reports index generation failed: ${e.message}`);
    }
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
