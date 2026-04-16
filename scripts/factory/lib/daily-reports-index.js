/**
 * Daily Reports Index Generator V16.7.2
 * Transitioned from Weekly to Daily cadence
 * Generates cache/reports/index.json from daily reports
 */

import fs from 'fs/promises';
import path from 'path';
import { zstdCompress, autoDecompress } from './zstd-helper.js';

const CONFIG = {
    DAILY_DIR: './output/daily',
    BACKUP_DIR: './output/meta/daily-backup',
    OUTPUT_DIR: './output/cache/reports',
    VERSION: '16.7.2'
};

/**
 * Generate reports index
 */
export async function generateDailyReportsIndex(outputDir = './output') {
    console.log('[REPORTS-INDEX] Generating daily reports index...');

    const dailyDir = path.join(outputDir, 'daily');
    const backupDir = path.join(outputDir, 'meta', 'daily-backup');
    const reportsDir = path.join(outputDir, 'cache', 'reports');

    await fs.mkdir(reportsDir, { recursive: true });

    const reports = [];
    const CDN_BASE = 'https://cdn.free2aitools.com';

    // V25.9: Pre-load existing index from CDN (try .zst first, .gz fallback)
    for (const ext of ['.zst', '.gz']) {
        try {
            const url = `${CDN_BASE}/cache/reports/index.json${ext}`;
            console.log(`  [REPORTS-INDEX] Fetching existing index from ${url}...`);
            const res = await fetch(url);
            if (res.ok) {
                const buffer = Buffer.from(await res.arrayBuffer());
                const content = await autoDecompress(buffer);
                const existing = JSON.parse(content.toString('utf-8'));
                if (existing.reports) {
                    reports.push(...existing.reports);
                    console.log(`  [REPORTS-INDEX] Loaded ${existing.reports.length} historical reports from CDN.`);
                }
                break;
            }
        } catch (e) {
            console.warn(`  [REPORTS-INDEX] Could not load existing index (${ext}): ${e.message}`);
        }
    }

    // V26.12: Backfill historical report bodies from CDN. The CDN index.json.zst
    // only carries metadata; individual report bodies live at cache/reports/daily/<id>.json.zst.
    // Without this pass, buildReportDb (meta-anchors.js) scans disk and sees only
    // reports freshly generated this cycle — meta-report.db ends up with 1 row.
    const dailyReportsDir = path.join(reportsDir, 'daily');
    await fs.mkdir(dailyReportsDir, { recursive: true });
    let backfilled = 0;
    let backfillFailed = 0;
    for (const r of reports) {
        const localPath = path.join(dailyReportsDir, `${r.id}.json.zst`);
        try { await fs.access(localPath); continue; } catch { /* not on disk — fetch */ }
        try {
            const res = await fetch(`${CDN_BASE}/cache/reports/daily/${r.id}.json.zst`);
            if (res.ok) {
                await fs.writeFile(localPath, Buffer.from(await res.arrayBuffer()));
                backfilled++;
            } else {
                backfillFailed++;
            }
        } catch (e) {
            backfillFailed++;
            console.warn(`  [REPORTS-INDEX] Backfill fetch failed for ${r.id}: ${e.message}`);
        }
    }
    if (backfilled > 0 || backfillFailed > 0) {
        console.log(`  [REPORTS-INDEX] Historical backfill: ${backfilled} fetched, ${backfillFailed} failed/missing`);
    }

    // Scan directories
    const dirsToScan = [dailyDir, backupDir];

    for (const dir of dirsToScan) {
        try {
            const files = await fs.readdir(dir);
            const jsonFiles = files.filter(f => f.endsWith('.json') || f.endsWith('.json.zst') || f.endsWith('.json.gz'));

            for (const file of jsonFiles) {
                try {
                    const filePath = path.join(dir, file);
                    let content = await fs.readFile(filePath);
                    content = await autoDecompress(content);
                    const reportData = JSON.parse(content.toString('utf-8'));

                    const reportId = reportData.id || file.replace(/\.json(\.zst|\.gz)?$/, '');

                    // Skip if already processed
                    if (reports.find(r => r.id === reportId)) continue;

                    const highlightsCount = reportData.highlights?.length || 0;

                    reports.push({
                        id: reportId,
                        type: 'daily',
                        title: reportData.title || `AI Daily Report ${reportId}`,
                        date: reportData.datePublished || reportData.date || reportId,
                        highlights: highlightsCount
                    });

                    // V25.9: Sync to cache location (Zstd)
                    const dailyReportsDir = path.join(reportsDir, 'daily');
                    await fs.mkdir(dailyReportsDir, { recursive: true });

                    const newPath = path.join(dailyReportsDir, `${reportId}.json.zst`);
                    await fs.writeFile(newPath, await zstdCompress(JSON.stringify({
                        _v: CONFIG.VERSION,
                        ...reportData,
                        id: reportId,
                        type: 'daily'
                    })));

                } catch (e) {
                    console.warn(`  [WARN] Failed to process ${file}: ${e.message}`);
                }
            }
        } catch (e) { /* skip */ }
    }

    // Sort descending
    reports.sort((a, b) => b.id.localeCompare(a.id));

    const index = {
        _v: CONFIG.VERSION,
        _ts: new Date().toISOString(),
        latest: reports[0]?.id || null,
        total_daily: reports.length,
        reports
    };

    await fs.writeFile(path.join(reportsDir, 'index.json.zst'), await zstdCompress(JSON.stringify(index)));

    console.log(`✅ [REPORTS-INDEX] Generated index with ${reports.length} daily reports`);
    return { total: reports.length };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
    generateDailyReportsIndex(process.argv[2] || './output').catch(err => { console.error('❌ [REPORTS-INDEX] Fatal:', err); process.exit(1); });
}
