/**
 * V25.8 Knowledge AI — Gemini Pure Text Mode for knowledge articles.
 * Spec §4: Gemini creates content; Rust builds the mesh.
 * Extracted from generate-knowledge.js for CES Art 5.1 compliance.
 */

const GEMINI_MODEL = 'gemini-3.0-pro';
const STAGGER_DELAY_MS = 35000; // V25.8 §4.1: 35s mandatory delay between AI tasks

/**
 * V25.8 §4: AI-Assisted content generation via Gemini (Pure Text Mode).
 * @param {object} topic - { slug, title, description, category }
 * @returns {object|null} Generated sections or null on failure
 */
export async function generateWithGemini(topic) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    // V25.8 §4.2: Jittered Ingestion (0-3s random delay)
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 3000)));

    const prompt = `Write a concise, technical knowledge article about "${topic.title}" for an AI tools directory.

Requirements:
- Professional, data-driven tone (like Gartner/McKinsey)
- 400-600 words total
- Sections: Overview, How It Works, Key Use Cases, Limitations
- Use industry terminology (RAG, MoE, KV Cache, etc.) where relevant
- No marketing fluff, focus on technical accuracy

Return ONLY valid JSON: {"overview":"...","howItWorks":"...","useCases":"...","limitations":"..."}`;

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.3, maxOutputTokens: 1024, responseMimeType: 'application/json' }
                })
            }
        );
        if (!response.ok) return null;
        const data = await response.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let clean = raw.trim();
        if (clean.startsWith('```')) {
            const m = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (m) clean = m[1];
        }
        return JSON.parse(clean);
    } catch (e) {
        console.warn(`[AI-KNOWLEDGE] Gemini failed for ${topic.slug}: ${e.message}`);
        return null;
    }
}

/**
 * V25.8 §4.1: Enforce 35s stagger delay between AI tasks.
 */
export async function enforceKnowledgeStagger() {
    console.log(`[AI-KNOWLEDGE] V25.8: Enforcing ${STAGGER_DELAY_MS / 1000}s stagger delay...`);
    await new Promise(r => setTimeout(r, STAGGER_DELAY_MS));
}

/**
 * Known topic seeds for pending article detection.
 */
export function getKnownTopics() {
    return {
        benchmark: [
            { slug: 'mmlu', title: 'MMLU Benchmark', description: 'Massive Multitask Language Understanding', category: 'benchmark' },
            { slug: 'humaneval', title: 'HumanEval', description: 'Code generation benchmark by OpenAI', category: 'benchmark' },
        ],
        architecture: [
            { slug: 'mixture-of-experts', title: 'Mixture of Experts (MoE)', description: 'Sparse expert routing architecture', category: 'architecture' },
            { slug: 'kv-cache', title: 'KV Cache Optimization', description: 'Key-Value cache for transformer inference', category: 'architecture' },
        ],
        'model-family': [
            { slug: 'llama-family', title: 'Llama Model Family', description: 'Meta open-source LLM family', category: 'model-family' },
            { slug: 'qwen-family', title: 'Qwen Model Family', description: 'Alibaba multilingual LLM series', category: 'model-family' },
        ]
    };
}
