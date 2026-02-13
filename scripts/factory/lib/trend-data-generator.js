/**
 * Trend Data Generator
 * V14.5 Phase 5: Generates trend-data.json for frontend charts
 * 
 * Input: FNI history (7-day rolling scores)
 * Output: trend-data.json with scores, change%, and direction
 * 
 * Constitution: Art 6.3 (Client-side only)
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';

/**
 * Generate trend data from FNI history
 * @param {Object} fniHistory - FNI history data { entities: { [id]: [{date, score}] } }
 * @param {string} outputDir - Output directory (default: output/cache)
 * @returns {Promise<Object>} - Generated trend data stats
 */
export async function generateTrendData(fniHistory, outputDir = 'output/cache') {
    console.log('[TREND] Generating trend data...');

    const entities = fniHistory?.entities || {};
    const trendData = {};
    let processedCount = 0;
    let skippedCount = 0;

    // Sort entities by latest FNI score to prioritize top entities
    const sortedEntities = Object.entries(entities)
        .filter(([id, history]) => history && history.length >= 2)
        .sort((a, b) => {
            const aLatest = a[1][a[1].length - 1]?.score || 0;
            const bLatest = b[1][b[1].length - 1]?.score || 0;
            return bLatest - aLatest;
        })
        .slice(0, 5000); // Top 5000 entities only

    for (const [id, history] of sortedEntities) {
        const scores = history.map(h => h.score);
        const dates = history.map(h => h.date);
        const latest = scores[scores.length - 1];
        const oldest = scores[0];

        // Calculate 7-day change percentage
        let change7d = 0;
        if (oldest > 0) {
            change7d = parseFloat(((latest - oldest) / oldest * 100).toFixed(1));
        }

        // Determine direction
        let direction = 'stable';
        if (change7d > 1) direction = 'up';
        else if (change7d < -1) direction = 'down';

        trendData[id] = {
            scores: scores.slice(-7),
            dates: dates.slice(-7),
            change7d,
            direction,
            latest
        };

        processedCount++;
    }

    skippedCount = Object.keys(entities).length - processedCount;

    // Ensure output directory exists
    const trendPath = path.join(outputDir, 'trend-data.json.gz');
    await fs.mkdir(path.dirname(trendPath), { recursive: true });

    // Write trend data (Gzipped via SmartWriter)
    await smartWriteWithVersioning('trend-data.json', trendData, outputDir, { compress: true });

    const fileSize = (await fs.stat(trendPath)).size;

    console.log(`[TREND] ✅ Generated trend-data.json`);
    console.log(`  - Entities: ${processedCount}`);
    console.log(`  - Skipped: ${skippedCount}`);
    console.log(`  - Size: ${(fileSize / 1024).toFixed(1)} KB`);

    return {
        processed: processedCount,
        skipped: skippedCount,
        fileSizeBytes: fileSize,
        path: trendPath
    };
}

export default generateTrendData;
