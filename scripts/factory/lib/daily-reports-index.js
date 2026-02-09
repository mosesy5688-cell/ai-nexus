/**
 * Daily Reports Index Generator V16.7.2
 * Transitioned from Weekly to Daily cadence
 * Generates cache/reports/index.json from daily reports
 */

import fs from 'fs/promises';
import path from 'path';

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

    // Scan directories
    const dirsToScan = [dailyDir, backupDir];

    for (const dir of dirsToScan) {
        try {
            const files = await fs.readdir(dir);
            const jsonFiles = files.filter(f => f.endsWith('.json') || f.endsWith('.json.gz'));

            for (const file of jsonFiles) {
                try {
                    const filePath = path.join(dir, file);
                    let content = await fs.readFile(filePath);
                    if (file.endsWith('.gz') || (content[0] === 0x1f && content[1] === 0x8b)) {
                        const zlib = await import('zlib');
                        content = zlib.gunzipSync(content);
                    }
                    const reportData = JSON.parse(content.toString('utf-8'));

                    const reportId = reportData.id || file.replace(/\.json(\.gz)?$/, '');

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

                    // Sync to cache location (V17.9: Direct into reportsDir)
                    const zlib = await import('zlib');
                    const newPath = path.join(reportsDir, `${reportId}.json.gz`);
                    await fs.writeFile(newPath, zlib.gzipSync(JSON.stringify({
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

    const zlib = await import('zlib');
    await fs.writeFile(path.join(reportsDir, 'index.json.gz'), zlib.gzipSync(JSON.stringify(index)));

    console.log(`✅ [REPORTS-INDEX] Generated index with ${reports.length} daily reports`);
    return { total: reports.length };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
    generateDailyReportsIndex(process.argv[2] || './output').catch(console.error);
}
