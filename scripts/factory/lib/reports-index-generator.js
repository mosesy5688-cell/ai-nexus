/**
 * Reports Index Generator V16.2
 * SPEC: SPEC-KNOWLEDGE-MESH-V16.2 Section 5.4, 6.2
 * 
 * Generates cache/reports/index.json from weekly reports
 * Runs in Factory 3/4 Aggregate stage
 * 
 * @module scripts/factory/lib/reports-index-generator
 */

import fs from 'fs/promises';
import path from 'path';

const CONFIG = {
    WEEKLY_DIR: './output/weekly',
    OUTPUT_DIR: './output/cache/reports',
    VERSION: '16.2'
};

/**
 * Check if annual report should be generated
 * Trigger: Dec 31 or first Sunday of January
 */
function shouldGenerateAnnualReport() {
    const now = new Date();
    const isDecember31 = now.getMonth() === 11 && now.getDate() === 31;
    const isFirstSundayOfJanuary = now.getMonth() === 0 &&
        now.getDate() <= 7 && now.getDay() === 0;
    return isDecember31 || isFirstSundayOfJanuary;
}

/**
 * Parse week ID from filename or report data
 */
function parseWeekId(filename, reportData) {
    if (reportData?.id) return reportData.id;
    // Extract YYYY-Wxx from filename
    const match = filename.match(/(\d{4}-W\d{2})/);
    return match ? match[1] : filename.replace('.json', '');
}

/**
 * Generate reports index from weekly directory
 */
export async function generateReportsIndex(outputDir = './output') {
    console.log('[REPORTS-INDEX V16.2] Generating reports index...');

    const weeklyDir = path.join(outputDir, 'weekly');
    const reportsDir = path.join(outputDir, 'cache', 'reports');

    await fs.mkdir(reportsDir, { recursive: true });
    await fs.mkdir(path.join(reportsDir, 'weekly'), { recursive: true });
    await fs.mkdir(path.join(reportsDir, 'annual'), { recursive: true });

    const reports = [];
    let latestId = null;

    // Scan weekly reports
    try {
        const files = await fs.readdir(weeklyDir);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        for (const file of jsonFiles) {
            try {
                const filePath = path.join(weeklyDir, file);
                const content = await fs.readFile(filePath, 'utf-8');
                const reportData = JSON.parse(content);

                const weekId = parseWeekId(file, reportData);
                const highlightsCount = reportData.highlights?.length || 0;

                reports.push({
                    id: weekId,
                    type: 'weekly',
                    title: reportData.title || `Week ${weekId} Report`,
                    date: reportData.date_published || reportData.date || new Date().toISOString().split('T')[0],
                    highlights: highlightsCount
                });

                // Copy to new location
                const newPath = path.join(reportsDir, 'weekly', `${weekId}.json`);
                await fs.writeFile(newPath, JSON.stringify({
                    _v: CONFIG.VERSION,
                    _ts: new Date().toISOString(),
                    ...reportData,
                    id: weekId,
                    type: 'weekly'
                }, null, 2));

                console.log(`  [REPORT] ${weekId}: ${highlightsCount} highlights`);
            } catch (e) {
                console.warn(`  [WARN] Failed to process ${file}: ${e.message}`);
            }
        }
    } catch (e) {
        console.warn(`  [WARN] Weekly directory not found: ${e.message}`);
    }

    // Sort by date descending
    reports.sort((a, b) => b.id.localeCompare(a.id));
    latestId = reports[0]?.id || null;

    // Check for annual report
    if (shouldGenerateAnnualReport()) {
        const year = new Date().getFullYear();
        console.log(`  [ANNUAL] Generating ${year} annual report...`);
        // Annual report generation would aggregate weekly data
        // This is a placeholder for the full implementation
    }

    // Generate index
    const index = {
        _v: CONFIG.VERSION,
        _ts: new Date().toISOString(),
        latest: latestId,
        total_weekly: reports.filter(r => r.type === 'weekly').length,
        total_annual: reports.filter(r => r.type === 'annual').length,
        reports
    };

    const indexPath = path.join(reportsDir, 'index.json');
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

    console.log(`[REPORTS-INDEX] Generated index with ${reports.length} reports`);
    console.log(`  Latest: ${latestId || 'none'}`);

    return { total: reports.length, latest: latestId };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const outputDir = process.argv[2] || './output';
    generateReportsIndex(outputDir)
        .then(result => console.log(`✅ Reports index complete: ${result.total} reports`))
        .catch(e => {
            console.error('❌ Reports index failed:', e.message);
            process.exit(1);
        });
}
