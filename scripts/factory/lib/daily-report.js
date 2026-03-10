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
const GEMINI_MODEL = 'gemini-3.1-flash'; // Upgraded to Gemini 3.1 Flash for maximum reasoning per $5 quota stability limit

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

    const prompt = `你是顶级技术咨询公司 (如 Gartner/McKinsey) 的首席 AI 分析师，代表 free2aitools 品牌。基于以下数据，生成今天的人工智能行业洞察报告。

今日排名前 3 的实体:
${top3}

总计有 ${topEntities.length} 个高价值实体登上了今日榜单。

严格要求 (Requirements):
1. title: 必须采用此格式: "free2aitools 每日报告：[核心技术突破/趋势关键词]"。例如: "free2aitools 每日报告：DeepSeek-V3 架构解析与长文本推理性能的跨代跨越"
2. subtitle: 15-25 词，概括今天最核心的数据点和进展。
3. summary: 100-150 词。你的分析必须包含三部分：① 今日重大突破客观总结 ② 行业影响 (Implications) ③ 技术展望 (Outlook)。

格式与风格 (Style):
- 专业、客观、数据驱动、硬核。
- 强制使用高频行业专业术语 (如 RAG, Agentic Workflows, Inference Scaling, KV Cache, Mixture of Experts 等)。
- 明确指出相较于"昨日"的变化点，并引用具体的模型/论文名称。

返回严格的 JSON 格式 (Return ONLY valid JSON):
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
        let aiContent = null;
        try {
            // V18.2.3: Robust JSON Extraction (handles case where model wraps response in backticks)
            const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            let cleanText = rawText.trim();
            if (cleanText.startsWith('```')) {
                const match = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                if (match) cleanText = match[1];
            }
            aiContent = JSON.parse(cleanText);
        } catch (parseError) {
            console.warn(`[AI] JSON parse failed: ${parseError.message}`);
            return null;
        }

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
            ...e, // V18.2.1 GA: Inclusive backup
            id: e.id,
            name: e.name || e.slug,
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
