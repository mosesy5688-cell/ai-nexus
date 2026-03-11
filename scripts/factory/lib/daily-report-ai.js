/**
 * Daily Report AI Module V1.0
 * Extracted from daily-report.js to comply with CES Art 5.1
 */

const GEMINI_MODEL = 'gemini-2.0-flash';

/**
 * Generate AI content using Gemini
 */
export async function generateAIContent(topEntities) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn('[AI] GEMINI_API_KEY not set, using fallback template');
        return null;
    }

    const top3 = topEntities.slice(0, 3).map((e, i) =>
        `${i + 1}. ${e.name} (FNI: ${e.fni_score?.toFixed(1) || 'N/A'}, type: ${e.type || 'model'})`
    ).join('\n');

    const systemInstruction = `You are the lead AI analyst at a top-tier tech consulting firm (e.g., Gartner/McKinsey), representing the free2aitools brand.
Your style must be professional, objective, data-driven, and hardcore.
Mandatory use of high-frequency industry terminology (e.g., RAG, Agentic Workflows, Inference Scaling, KV Cache, Mixture of Experts).
You must act as a strict data formatter. Return ONLY valid JSON.`;

    const prompt = `Based on the following data, generate today's artificial intelligence industry insight report.

Top 3 entities today:
${top3}

A total of ${topEntities.length} high-value entities made it to today's list.

Strict Requirements:
1. title: MUST use exactly this format: "free2aitools Daily Report: [Core Tech Breakthrough/Trend Keyword]". Example: "free2aitools Daily Report: DeepSeek-V3 Architecture Analysis & Long-Context Reasoning Breakthrough"
2. subtitle: 15-25 words, summarizing today's core data points and advancements.
3. summary: 100-150 words. Your analysis must contain three parts: (1) Objective summary of today's major breakthroughs, (2) Industry Implications, (3) Technical Outlook.
4. Explicitly point out what changed compared to "yesterday" and cite specific model/paper names.

Return exactly this JSON format:
{"title": "...", "subtitle": "...", "summary": "..."}`;

    try {
        // Physical Throttle (15 RPM Death Line) -> 4100ms mandatory wait
        console.log('[AI] Physical Throttle Engaged: Sleeping 4.1s to respect 15 RPM limit.');
        await new Promise(resolve => setTimeout(resolve, 4100));

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: 512,
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
