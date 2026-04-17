/**
 * Daily Report AI Module V3.1
 * Uses shared Titan Fetch for hardened Gemini API calls.
 */

import { callGemini } from './titan-fetch.js';

/**
 * Generate AI content for daily report using Gemini.
 * @param {Array} topEntities - Top entities by FNI score
 * @param {string[]} recentTitles - Titles from the past 7 days (for dedup)
 */
export async function generateAIContent(topEntities, recentTitles = []) {
    const top10 = topEntities.slice(0, 10).map((e, i) => {
        const fni = typeof e.fni_score === 'number' ? e.fni_score.toFixed(1) : 'N/A';
        return `${i + 1}. ${e.name} (FNI: ${fni}, type: ${e.type || 'model'})`;
    }).join('\n');

    const systemInstruction = `You are a Senior AI/ML Technical Analyst at a top-tier consulting firm. Your goal is to analyze daily market moves and technical breakthroughs, providing high-level strategic insights for the free2aitools brand.

Rules:
- Professional, objective, data-driven tone. No hype or marketing language.
- Use precise industry terminology relevant to the entities being analyzed.
- Cite specific model names, paper titles, and quantitative metrics when available.
- Compare today's landscape against yesterday's to highlight deltas.
- Return ONLY valid JSON. No markdown, no commentary outside JSON.`;

    const recentTitlesBlock = recentTitles.length > 0
        ? `\nRecent titles (past 7 days) — AVOID keyword overlap with these:\n${recentTitles.map(t => `- ${t}`).join('\n')}\n`
        : '';

    const prompt = `Based on the following data, generate today's artificial intelligence industry insight report.

Top 10 entities today:
${top10}

A total of ${topEntities.length} high-value entities made it to today's list.
${recentTitlesBlock}
Strict Requirements:
1. title: MUST use exactly this format: "free2aitools Daily Report: [Core Tech Breakthrough/Trend Keyword]". The keyword MUST reflect today's specific top entities — do NOT reuse themes from recent titles listed above.
2. subtitle: 15-25 words, summarizing today's core data points and advancements.
3. summary: 100-150 words. Your analysis must contain three parts: (1) Objective summary of today's major breakthroughs, (2) Industry Implications, (3) Technical Outlook.
4. Explicitly point out what changed compared to "yesterday" and cite specific model/paper names.

Return exactly this JSON format:
{"title": "...", "subtitle": "...", "summary": "..."}`;

    const aiContent = await callGemini({ systemInstruction, prompt, temperature: 0.7, maxOutputTokens: 1024 });

    if (!aiContent) return null;

    // Validate required fields exist and are non-empty
    if (!aiContent.title || !aiContent.summary || aiContent.summary.length < 50) {
        console.warn('[AI] Content validation failed: missing or truncated fields. Rejecting.');
        return null;
    }

    console.log(`[AI] Generated Daily Title: "${aiContent.title}"`);
    return aiContent;
}
