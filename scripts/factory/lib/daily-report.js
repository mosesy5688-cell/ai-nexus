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
import { zstdCompress, autoDecompress } from './zstd-helper.js';

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
            // V18.9: FNI Singularity is sole scoring authority
            let score = e.fni_score || e.fni || 0;

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
    // V25.9: Try .zst first, then .gz (legacy), then plain JSON
    const candidatePaths = [reportPath + '.zst', reportPath + '.gz', reportPath];
    for (const candidate of candidatePaths) {
        try {
            const raw = await fs.readFile(candidate);
            const decompressed = await autoDecompress(raw);
            existingReport = JSON.parse(decompressed.toString('utf-8'));
            console.log(`  [REPORT] Existing report found for ${reportId}. Merging cumulative data...`);
            break;
        } catch { }
    }

    // V25.9: Standardize reportPath to .zst (V55.9 §73: 100% Zstd)
    const finalReportPath = reportPath + '.zst';

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
        // Collect past 7 days' titles for dedup
        const recentTitles = await getRecentTitles(dailyDir, reportId, 7);
        aiContent = await generateAIContent(topEntriesForAI, recentTitles);
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

    // Save to daily directory (V55.9 §73: Zstd only)
    await fs.mkdir(dailyDir, { recursive: true });
    await fs.writeFile(finalReportPath, await zstdCompress(JSON.stringify(report, null, 2)));

    // Archive backup
    const backupDir = path.join(outputDir, 'meta', 'daily-backup');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, `${reportId}.json.zst`), await zstdCompress(JSON.stringify(report, null, 2)));

    // V25.9: VFS Assimilation — emit Fused Entity for aggregator pipeline ingestion
    await exportReportFusedEntity(report, outputDir);

    // Clear accumulator after successful generation
    await saveDailyAccum({ entries: [], lastUpdated: new Date().toISOString() });

    console.log(`  [REPORT] Generated/Updated Daily ${reportId}: "${title}" (${combinedHighlights.length} highlights)`);
}

/**
 * V25.9: Export daily report as Fused Entity Object to cache/fused/.
 * Enables FTS5 indexing, Sitemap inclusion, and Global Search visibility.
 */
async function exportReportFusedEntity(report, outputDir) {
    const fusedEntity = {
        id: `report--${report.id}`,
        slug: `report--${report.id}`,
        name: report.title,
        type: 'report',
        description: report.summary || '',
        body_content: JSON.stringify(report.highlights || []),
        summary: report.subtitle || report.summary || '',
        author: 'Free2AI',
        category: 'daily-report',
        tags: ['AI', 'report', 'daily', 'industry'],
        fni_score: 30,
        source: 'daily-report-gen',
        source_platform: 'internal',
        pipeline_tag: 'daily-report',
        created_at: report.datePublished || new Date().toISOString(),
        last_modified: report._updated || new Date().toISOString(),
    };

    const fusedDir = path.join(process.env.CACHE_DIR || path.join(outputDir, 'cache'), 'fused');
    await fs.mkdir(fusedDir, { recursive: true });
    const fusedPath = path.join(fusedDir, `${fusedEntity.id}.json.zst`);
    await fs.writeFile(fusedPath, await zstdCompress(JSON.stringify(fusedEntity)));
    console.log(`  [REPORT] VFS Entity exported: ${fusedEntity.id}`);
}

/**
 * V25.9: Streaming-compatible daily accumulator update.
 * Accepts pre-sorted top-N entities (bounded array) from streaming pass.
 */
export async function updateDailyAccumulatorFromTopN(topEntities, outputDir = './output') {
    console.log('[DAILY] Updating daily accumulator from streaming top-N...');
    const accumulator = await loadDailyAccum();

    const entries = topEntities.map(e => ({
        id: e.id,
        name: e.name || e.slug,
        type: e.type || 'model',
        fni_score: Math.round(e.fni_score || e.fni || 0),
        date: new Date().toISOString().split('T')[0],
        pipeline_tag: e.pipeline_tag || '',
        author: e.author || 'Community'
    }));

    accumulator.entries = accumulator.entries || [];
    accumulator.entries.push(...entries);
    const MAX_ACCUM_ENTRIES = 1500;
    if (accumulator.entries.length > MAX_ACCUM_ENTRIES) {
        accumulator.entries = accumulator.entries.slice(-MAX_ACCUM_ENTRIES);
    }
    accumulator._updated = new Date().toISOString();

    await saveDailyAccum(accumulator);
    console.log(`  [DAILY] Accumulated ${accumulator.entries.length} entries total (streaming).`);
}

/**
 * Read titles from the past N days' reports for dedup.
 */
async function getRecentTitles(dailyDir, currentDateId, days = 7) {
    const titles = [];
    for (let i = 1; i <= days; i++) {
        const d = new Date(currentDateId);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        const candidates = [`${dateStr}.json.zst`, `${dateStr}.json.gz`, `${dateStr}.json`];
        for (const file of candidates) {
            try {
                const raw = await fs.readFile(path.join(dailyDir, file));
                const data = JSON.parse((await autoDecompress(raw)).toString('utf-8'));
                if (data.title) titles.push(data.title);
                break;
            } catch { /* file doesn't exist for this day */ }
        }
    }
    return titles;
}

function calculateAvgFni(entries) {
    if (!entries.length) return 0;
    const sum = entries.reduce((acc, e) => acc + (e.fni_score || 0), 0);
    return Math.round(sum / entries.length * 10) / 10;
}
