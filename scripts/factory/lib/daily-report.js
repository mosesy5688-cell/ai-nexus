/**
 * Daily Report Module V16.7.2
 * Transitioned from Weekly to Daily cadence
 * Constitution Reference: Art 5 (Report System)
 * V16.7.2: Gemini AI-powered daily insights
 */

import fs from 'fs/promises';
import path from 'path';
import { loadDailyAccum, saveDailyAccum } from './cache-manager.js';
import { generateAIContent } from './daily-report-ai.js';

const DAILY_TOP_ENTITIES = 50;

/**
 * Update daily accumulator
 */
export async function updateDailyAccumulator(entities, outputDir = './output') {
    console.log('[DAILY] Updating daily accumulator...');

    const accumulator = await loadDailyAccum();

    // V17.3: Changed from FNI>=70 threshold to Top N by FNI
    // Ensures daily reports always have content
    const topMovers = entities
        .filter(e => (e.fni_score || e.fni || 0) > 0)  // Only filter out zero/missing FNI
        .sort((a, b) => (b.fni_score || b.fni || 0) - (a.fni_score || a.fni || 0))
        .slice(0, DAILY_TOP_ENTITIES)
        .map(e => {
            // V25.1.2: Ensure FNI score is prioritized and has fallout protection 
            let score = e.fni_score || e.fni || 0;
            if (score === 0 && e.quality_score) score = e.quality_score;

            return {
                id: e.id,
                name: e.name || e.slug,
                type: e.type || 'model',
                fni_score: Math.round(score),
                date: new Date().toISOString().split('T')[0],
                pipeline_tag: e.pipeline_tag || '',
                author: e.author || 'Community'
            };
        });

    accumulator.entries = accumulator.entries || [];
    accumulator.entries.push(...topMovers);
    accumulator._updated = new Date().toISOString();

    await saveDailyAccum(accumulator);

    console.log(`  [DAILY] Accumulated ${accumulator.entries.length} entries total`);
}

/**
 * V16.7.2: Always generate report on every Factory run
 */
export function shouldGenerateReport() {
    return true;
}

/**
 * Generate daily report
 * V16.8.2: Cumulative Merging Logic (Supports multi-run stability)
 */
export async function generateDailyReport(outputDir = './output') {
    const reportId = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    console.log(`[REPORT] Processing daily report for ${reportId}...`);

    const accumulator = await loadDailyAccum();
    const dailyDir = path.join(outputDir, 'daily');
    const reportPath = path.join(dailyDir, `${reportId}.json`);

    let existingReport = null;
    try {
        let existingContent = await fs.readFile(reportPath);
        if (existingContent[0] === 0x1f && existingContent[1] === 0x8b) {
            const zlib = await import('zlib');
            existingContent = zlib.gunzipSync(existingContent);
        }
        existingReport = JSON.parse(existingContent.toString('utf-8'));
        console.log(`  [REPORT] Existing report found for ${reportId}. Merging cumulative data...`);
    } catch (e) {
        // Try .gz fallback if the primary path didn't work and wasn't already .gz
        if (!reportPath.endsWith('.gz')) {
            try {
                let existingContent = await fs.readFile(reportPath + '.gz');
                const zlib = await import('zlib');
                existingContent = zlib.gunzipSync(existingContent);
                existingReport = JSON.parse(existingContent.toString('utf-8'));
                console.log(`  [REPORT] Existing report found for ${reportId} (.gz). Merging cumulative data...`);
            } catch (e2) { }
        }
    }

    // V18.2: Standardize reportPath to .gz
    const finalReportPath = reportPath.endsWith('.gz') ? reportPath : reportPath + '.gz';

    if ((!accumulator.entries || accumulator.entries.length === 0) && !existingReport) {
        console.warn('[WARN] No daily entries found and no existing report to update');
        return;
    }

    // Prepare Highlights: Merge existing + new accomplishments
    const newHighlights = (accumulator.entries || []).map(e => ({
        ...e, // V18.2.1 GA: Inclusive Highlights
        entity_id: e.id,
        fni_score: e.fni_score || e.fni || 0
    }));

    // Deduplicate by entity_id (V16.8.2 Optimization)
    const highlightsMap = new Map();
    if (existingReport?.highlights) {
        existingReport.highlights.forEach(h => highlightsMap.set(h.entity_id, h));
    }
    newHighlights.forEach(h => highlightsMap.set(h.entity_id, h));

    const combinedHighlights = Array.from(highlightsMap.values())
        .sort((a, b) => b.fni_score - a.fni_score); // Maintain FNI sort

    // Get top entries for AI (skip if already generated for today to save quota/avoid 429)
    let aiContent = null;
    if (existingReport?.aiGenerated && existingReport?.title && !existingReport.title.startsWith('AI Daily Digest')) {
        console.log(`  [AI] Report for ${reportId} already has AI content. Skipping generation.`);
    } else {
        const topEntriesForAI = combinedHighlights.slice(0, 10);
        aiContent = await generateAIContent(topEntriesForAI);
    }

    const title = aiContent?.title || existingReport?.title || `AI Daily Digest - ${reportId}`;
    const subtitle = aiContent?.subtitle || existingReport?.subtitle || 'Daily update on AI Models, Papers, and Tools';
    const summary = aiContent?.summary || existingReport?.summary || `${combinedHighlights.length} high-FNI entities identified today.`;

    const report = {
        id: reportId,
        title,
        subtitle,
        summary,
        type: 'daily',
        aiGenerated: !!aiContent,
        datePublished: existingReport?.datePublished || new Date().toISOString(),
        highlights: combinedHighlights,
        stats: {
            totalEntries: combinedHighlights.length,
            avgFni: calculateAvgFni(combinedHighlights.map(h => ({ fni_score: h.fni_score }))),
        },
        _v: '16.8.2',
        _generated: existingReport?._generated || new Date().toISOString(),
        _updated: new Date().toISOString()
    };

    // Save to daily directory
    const zlib = await import('zlib');
    await fs.mkdir(dailyDir, { recursive: true });
    await fs.writeFile(finalReportPath, zlib.gzipSync(JSON.stringify(report, null, 2)));

    // Archive backup
    const backupDir = path.join(outputDir, 'meta', 'daily-backup');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, `${reportId}.json.gz`), zlib.gzipSync(JSON.stringify(report, null, 2)));

    // Clear accumulator after successful generation
    await saveDailyAccum({ entries: [], lastUpdated: new Date().toISOString() });

    console.log(`  [REPORT] Generated/Updated Daily ${reportId}: "${title}" (${combinedHighlights.length} highlights)`);
}

function calculateAvgFni(entries) {
    if (!entries.length) return 0;
    const sum = entries.reduce((acc, e) => acc + (e.fni_score || 0), 0);
    return Math.round(sum / entries.length * 10) / 10;
}
