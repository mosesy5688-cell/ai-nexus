/**
 * Trends Summary Generator — produces weekly summary for /trends page.
 * Reads FNI history, computes top risers/fallers/new entries per category.
 * Uses Gemini (titan) for narrative analysis.
 * Output: trends-summary row in meta-report.db (VFS-Only compliant).
 */

import { loadFniHistory } from './registry-history.js';
import { callGemini } from './titan-fetch.js';

const CATEGORIES = ['text-generation', 'text-to-image', 'feature-extraction', 'automatic-speech-recognition', 'object-detection'];
const TOP_N = 10;

export async function generateTrendsSummary(shardReader) {
    console.log('[TRENDS] Generating weekly trends summary...');
    const historyData = await loadFniHistory();
    const history = historyData.entities || {};

    const entityMeta = new Map();
    await shardReader(async (entities) => {
        for (const e of entities) {
            if (!entityMeta.has(e.id)) {
                entityMeta.set(e.id, { name: e.name || e.slug || e.id, type: e.type, pipeline_tag: e.pipeline_tag, author: e.author });
            }
        }
    }, { slim: true });

    const risers = [];
    const fallers = [];
    const categorySummary = {};

    for (const [id, entries] of Object.entries(history)) {
        if (!entries || entries.length < 2) continue;
        const latest = entries[entries.length - 1]?.score || 0;
        const weekAgo = entries.length >= 7 ? entries[entries.length - 7]?.score : entries[0]?.score;
        if (!weekAgo || weekAgo === 0) continue;
        const change = parseFloat((latest - weekAgo).toFixed(1));
        const meta = entityMeta.get(id) || { name: id, type: 'model' };
        const item = { id, name: meta.name, author: meta.author || '', type: meta.type, pipeline_tag: meta.pipeline_tag, fni_score: latest, change_7d: change };
        if (change > 1) risers.push(item);
        if (change < -1) fallers.push(item);

        const cat = meta.pipeline_tag || 'other';
        if (!categorySummary[cat]) categorySummary[cat] = { count: 0, total_fni: 0, rising: 0, falling: 0 };
        categorySummary[cat].count++;
        categorySummary[cat].total_fni += latest;
        if (change > 1) categorySummary[cat].rising++;
        if (change < -1) categorySummary[cat].falling++;
    }

    risers.sort((a, b) => b.change_7d - a.change_7d);
    fallers.sort((a, b) => a.change_7d - b.change_7d);

    for (const cat of Object.keys(categorySummary)) {
        const s = categorySummary[cat];
        s.avg_fni = s.count > 0 ? parseFloat((s.total_fni / s.count).toFixed(1)) : 0;
        delete s.total_fni;
        s.trend = s.rising > s.falling ? 'rising' : s.falling > s.rising ? 'falling' : 'stable';
    }

    const week = getISOWeek();
    const summary = {
        week,
        generated: new Date().toISOString(),
        top_risers: risers.slice(0, TOP_N),
        top_fallers: fallers.slice(0, TOP_N),
        category_summary: categorySummary,
        total_tracked: Object.keys(history).length,
    };

    // Gemini narrative analysis
    try {
        const topRisersText = risers.slice(0, 5).map(r => `${r.name} (${r.author}): +${r.change_7d} FNI`).join(', ');
        const topFallersText = fallers.slice(0, 5).map(r => `${r.name} (${r.author}): ${r.change_7d} FNI`).join(', ');
        const catText = Object.entries(categorySummary).slice(0, 5).map(([c, d]) => `${c}: ${d.count} models, avg FNI ${d.avg_fni}, ${d.trend}`).join('; ');
        const narrative = await callGemini({
            systemInstruction: 'You are an AI industry analyst. Write a concise weekly trend summary in 3-4 sentences. Focus on what changed and why it matters for AI developers. No markdown, plain text only. Return JSON: {"headline":"...","analysis":"..."}',
            prompt: `Week ${week} AI model trends:\nTop risers: ${topRisersText}\nTop fallers: ${topFallersText}\nCategories: ${catText}\nTotal tracked: ${summary.total_tracked}`,
            temperature: 0.3,
            maxOutputTokens: 256,
        });
        if (narrative) {
            summary.headline = narrative.headline || '';
            summary.analysis = narrative.analysis || '';
        }
    } catch (e) { console.warn(`[TRENDS] Gemini narrative skipped: ${e.message}`); }

    console.log(`[TRENDS] Week ${week}: ${risers.length} risers, ${fallers.length} fallers, ${Object.keys(categorySummary).length} categories`);
    return summary;
}

function getISOWeek() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return `${d.getFullYear()}-W${String(1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7)).padStart(2, '0')}`;
}
