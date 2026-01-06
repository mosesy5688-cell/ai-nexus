/**
 * Weekly Report Module V14.5
 * Constitution Reference: Art 5 (Weekly Report System)
 * V14.5: Uses cache-manager for GH Cache + R2 backup strategy
 */

import fs from 'fs/promises';
import path from 'path';
import { loadWeeklyAccum, saveWeeklyAccum } from './cache-manager.js';


const WEEKLY_TOP_ENTITIES = 50;

/**
 * Update weekly accumulator (Art 5.1)
 * V14.5: Uses cache-manager priority chain (GH Cache → R2 backup)
 */
export async function updateWeeklyAccumulator(entities, outputDir = './output') {
    console.log('[WEEKLY] Updating weekly accumulator...');

    // V14.5: Load from GH Cache → R2 backup → cold start
    const accumulator = await loadWeeklyAccum();

    // Get top movers (highest FNI)
    const topMovers = entities
        .filter(e => e.fni >= 70)
        .slice(0, WEEKLY_TOP_ENTITIES)
        .map(e => ({
            id: e.id,
            name: e.name || e.slug,
            type: e.type,
            fni: e.fni,
            date: new Date().toISOString().split('T')[0],
        }));

    accumulator.entries = accumulator.entries || [];
    accumulator.entries.push(...topMovers);
    accumulator._updated = new Date().toISOString();

    // V14.5: Save to GH Cache + R2 backup automatically
    await saveWeeklyAccum(accumulator);

    console.log(`  [WEEKLY] Accumulated ${accumulator.entries.length} entries total`);
}

/**
 * Check if today is Sunday
 */
export function isSunday() {
    return new Date().getDay() === 0;
}

/**
 * Generate weekly report (Art 5.2)
 * V14.5: Uses cache-manager for loading accumulator
 */
export async function generateWeeklyReport(outputDir = './output') {
    console.log('[REPORT] Generating weekly report...');

    // V14.5: Load from cache-manager priority chain
    const accumulator = await loadWeeklyAccum();
    if (!accumulator.entries || accumulator.entries.length === 0) {
        console.warn('[WARN] No weekly accumulator entries found');
        return;
    }

    // Step 1: Archive before clearing (Art 5.2)
    const weekNum = getWeekNumber();
    const year = new Date().getFullYear();
    const weekId = `${year}-W${weekNum.toString().padStart(2, '0')}`;

    const backupDir = path.join(outputDir, 'meta', 'weekly-backup');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, `${weekId}.json`), JSON.stringify(accumulator, null, 2));

    // Step 2: Generate report
    const report = {
        id: weekId,
        title: `AI Weekly Digest - Week ${weekNum}`,
        subtitle: 'Top AI Models, Papers, and Tools This Week',
        datePublished: new Date().toISOString(),
        highlights: accumulator.entries.slice(0, 10),
        stats: {
            totalEntries: accumulator.entries.length,
            avgFni: calculateAvgFni(accumulator.entries),
        },
        jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'NewsArticle',
            headline: `AI Weekly Digest - Week ${weekNum}`,
            datePublished: new Date().toISOString(),
            author: { '@type': 'Organization', name: 'Free2AITools' },
        },
        _generated: new Date().toISOString(),
    };

    const weeklyDir = path.join(outputDir, 'weekly');
    await fs.mkdir(weeklyDir, { recursive: true });
    await fs.writeFile(path.join(weeklyDir, `${weekId}.json`), JSON.stringify(report, null, 2));

    // Step 3: Clear accumulator on success (V14.5: uses cache-manager)
    await saveWeeklyAccum({ entries: [], week: null, startDate: null });

    console.log(`  [REPORT] Generated ${weekId}`);
}

function getWeekNumber() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const diff = now - start;
    const oneWeek = 604800000;
    return Math.ceil((diff + start.getDay() * 86400000) / oneWeek);
}
