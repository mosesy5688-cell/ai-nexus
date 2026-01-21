/**
 * Weekly Report Module V16.2
 * Constitution Reference: Art 5 (Weekly Report System)
 * V16.2: Gemini AI-powered titles and summaries
 */

import fs from 'fs/promises';
import path from 'path';
import { loadWeeklyAccum, saveWeeklyAccum } from './cache-manager.js';

const WEEKLY_TOP_ENTITIES = 50;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

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
        `${i + 1}. ${e.name} (FNI: ${e.fni?.toFixed(1) || 'N/A'}, type: ${e.type || 'model'})`
    ).join('\n');

    const prompt = `You are an AI technology editor. Based on the following data, generate a title, subtitle, and summary for a weekly report.

This Week's Top 3 Entities:
${top3}

Total ${topEntities.length} high-FNI entities made it to this week's list.

Requirements:
1. title: 10-20 words, highlight the most notable model or trend
2. subtitle: 15-25 words, supplement with key data points
3. summary: 50-80 words, objective analysis of this week's trends

Style requirements:
- Objective, professional, data-driven
- Avoid exaggerated words like "revolutionary" or "groundbreaking"
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
        console.log(`[AI] Generated: "${aiContent.title}"`);
        return aiContent;
    } catch (e) {
        console.warn(`[AI] Generation failed: ${e.message}`);
        return null;
    }
}

/**
 * Update weekly accumulator (Art 5.1)
 */
export async function updateWeeklyAccumulator(entities, outputDir = './output') {
    console.log('[WEEKLY] Updating weekly accumulator...');

    const accumulator = await loadWeeklyAccum();

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

    await saveWeeklyAccum(accumulator);

    console.log(`  [WEEKLY] Accumulated ${accumulator.entries.length} entries total`);
}

/**
 * V16.5: Always generate report on every Factory run (removed Sunday check)
 */
export function shouldGenerateReport() {
    return true;
}

/**
 * Generate weekly report (Art 5.2) - V16.2 AI Enhanced
 */
export async function generateWeeklyReport(outputDir = './output') {
    console.log('[REPORT] Generating weekly report (V16.2 AI Enhanced)...');

    const accumulator = await loadWeeklyAccum();
    if (!accumulator.entries || accumulator.entries.length === 0) {
        console.warn('[WARN] No weekly accumulator entries found');
        return;
    }

    // V16.5: Date-based report ID
    const reportId = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Archive backup
    const backupDir = path.join(outputDir, 'meta', 'weekly-backup');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, `${reportId}.json`), JSON.stringify(accumulator, null, 2));

    // Get top entries for AI
    const topEntries = accumulator.entries.slice(0, 10);

    // Try AI generation, fallback to template
    const aiContent = await generateAIContent(topEntries);

    // V16.5: AI-generated title only, no hardcoded "Weekly"
    const title = aiContent?.title || `AI Digest - ${reportId}`;
    const subtitle = aiContent?.subtitle || 'Top AI Models, Papers, and Tools';
    const summary = aiContent?.summary || `${accumulator.entries.length} high-FNI entities made it to the list.`;

    const report = {
        id: reportId,
        title,
        subtitle,
        summary,
        aiGenerated: !!aiContent,
        datePublished: new Date().toISOString(),
        highlights: topEntries.map(e => ({
            entity_id: e.id,
            name: e.name,
            type: e.type,
            fni: e.fni
        })),
        stats: {
            totalEntries: accumulator.entries.length,
            avgFni: calculateAvgFni(accumulator.entries),
        },
        disclaimer: aiContent
            ? 'Title and summary are AI-generated. Data is based on Free2AITools FNI metrics.'
            : null,
        jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'NewsArticle',
            headline: title,
            description: summary,
            datePublished: new Date().toISOString(),
            author: { '@type': 'Organization', name: 'Free2AITools' },
        },
        _generated: new Date().toISOString(),
    };

    const weeklyDir = path.join(outputDir, 'weekly');
    await fs.mkdir(weeklyDir, { recursive: true });
    await fs.writeFile(path.join(weeklyDir, `${reportId}.json`), JSON.stringify(report, null, 2));

    // Clear accumulator
    await saveWeeklyAccum({ entries: [], week: null, startDate: null });

    console.log(`  [REPORT] Generated ${reportId}: "${title}"`);
}

function getWeekNumber() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const diff = now - start;
    const oneWeek = 604800000;
    return Math.ceil((diff + start.getDay() * 86400000) / oneWeek);
}

function calculateAvgFni(entries) {
    if (!entries.length) return 0;
    const sum = entries.reduce((acc, e) => acc + (e.fni || 0), 0);
    return Math.round(sum / entries.length * 10) / 10;
}
