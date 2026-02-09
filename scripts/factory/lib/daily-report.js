/**
 * Daily Report Module V16.7.2
 * Transitioned from Weekly to Daily cadence
 * Constitution Reference: Art 5 (Report System)
 * V16.7.2: Gemini AI-powered daily insights
 */

import fs from 'fs/promises';
import path from 'path';
import { loadDailyAccum, saveDailyAccum } from './cache-manager.js';

const DAILY_TOP_ENTITIES = 50;
const GEMINI_MODEL = 'gemini-1.5-flash'; // Switched to 1.5 Flash for better quota stability

/**
 * Generate AI content using Gemini
 */
async function generateAIContent(topEntities) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn('[AI] GEMINI_API_KEY not set, using fallback template');
        return null;
    }

    const top3 = topEntities.slice(0, 3).map((e, i) =>
        `${i + 1}. ${e.name} (FNI: ${e.fni_score?.toFixed(1) || 'N/A'}, type: ${e.type || 'model'})`
    ).join('\n');

    const prompt = `You are an AI technology editor. Based on the following data, generate a title, subtitle, and summary for a DAILY report.

Latest Top 3 AI Entities:
${top3}

Total ${topEntities.length} high-FNI entities made it to today's list.

Requirements:
1. title: 10-20 words, highlight the most notable model or trend today
2. subtitle: 15-25 words, supplement with key data points
3. summary: 50-80 words, objective analysis of today's breakthroughs

Style requirements:
- Objective, professional, data-driven
- Focus on what changed SINCE YESTERDAY
- Emphasize specific data and model names

Return in JSON format:
{"title": "...", "subtitle": "...", "summary": "..."}`;

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 256,
                        responseMimeType: 'application/json'
                    }
                })
            }
        );

        if (!response.ok) {
            console.warn(`[AI] Gemini API error: ${response.status}`);
            return null;
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return null;

        const aiContent = JSON.parse(text);
        console.log(`[AI] Generated Daily Title: "${aiContent.title}"`);
        return aiContent;
    } catch (e) {
        console.warn(`[AI] Generation failed: ${e.message}`);
        return null;
    }
}

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
        .map(e => ({
            id: e.id,
            name: e.name || e.slug,
            type: e.type,
            fni_score: e.fni_score || e.fni || 0,
            date: new Date().toISOString().split('T')[0],
        }));

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
        const existingContent = await fs.readFile(reportPath);
        existingReport = JSON.parse(existingContent);
        console.log(`  [REPORT] Existing report found for ${reportId}. Merging cumulative data...`);
    } catch (e) {
        // No existing report for today, which is fine
    }

    if ((!accumulator.entries || accumulator.entries.length === 0) && !existingReport) {
        console.warn('[WARN] No daily entries found and no existing report to update');
        return;
    }

    // Prepare Highlights: Merge existing + new accomplishments
    const newHighlights = (accumulator.entries || []).map(e => ({
        entity_id: e.id,
        name: e.name,
        type: e.type,
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
    await fs.mkdir(dailyDir, { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

    // Archive backup
    const backupDir = path.join(outputDir, 'meta', 'daily-backup');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, `${reportId}.json`), JSON.stringify(report, null, 2));

    // Clear accumulator after successful generation
    await saveDailyAccum({ entries: [], lastUpdated: new Date().toISOString() });

    console.log(`  [REPORT] Generated/Updated Daily ${reportId}: "${title}" (${combinedHighlights.length} highlights)`);
}

function calculateAvgFni(entries) {
    if (!entries.length) return 0;
    const sum = entries.reduce((acc, e) => acc + (e.fni_score || 0), 0);
    return Math.round(sum / entries.length * 10) / 10;
}
