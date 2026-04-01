/**
 * V25.8 Knowledge AI — Gemini Pure Text Mode for knowledge articles.
 * Spec §4: Gemini creates content; Rust builds the mesh.
 * V3.1: Uses shared Titan Fetch for hardened retry + shared circuit breaker.
 */

import { callGemini, enforceStaggerDelay } from './titan-fetch.js';

/**
 * V25.8 §4: AI-Assisted content generation via Gemini (Pure Text Mode).
 * @param {object} topic - { slug, title, description, category }
 * @returns {object|null} Generated sections or null on failure
 */
export async function generateWithGemini(topic) {
    const systemInstruction = `You are a World-class AI Research Scientist. Your mission is to distill complex academic papers and architectures into clear, authoritative, and deeply technical explanatory articles for the free2aitools knowledge base.

Rules:
- Write with the rigor of a peer-reviewed survey paper, but the clarity of a senior engineer's tech talk.
- Use precise terminology: attention heads, sparse routing, quantization schemes, FLOP counts, perplexity, etc.
- Include concrete numbers (parameter counts, benchmark scores, latency figures) when the topic warrants them.
- Acknowledge limitations and open research questions honestly.
- Return ONLY valid JSON. No markdown, no commentary outside JSON.`;

    const prompt = `Write a concise, technical knowledge article about "${topic.title}" for an AI tools directory.

Requirements:
- Professional, data-driven tone (like Gartner/McKinsey)
- 400-600 words total
- Sections: Overview, How It Works, Key Use Cases, Limitations
- No marketing fluff, focus on technical accuracy

Return ONLY valid JSON: {"overview":"...","howItWorks":"...","useCases":"...","limitations":"..."}`;

    return callGemini({ systemInstruction, prompt, temperature: 0.3, maxOutputTokens: 1024 });
}

/**
 * V25.8 §4.1: Enforce stagger delay between AI tasks.
 */
export async function enforceKnowledgeStagger() {
    await enforceStaggerDelay();
}

/**
 * Known topic seeds for pending article detection.
 */
export function getKnownTopics() {
    return {
        benchmark: [
            { slug: 'mmlu', title: 'MMLU Benchmark', description: 'Massive Multitask Language Understanding', category: 'benchmark' },
        ],
        architecture: [
            { slug: 'mixture-of-experts', title: 'Mixture of Experts (MoE)', description: 'Sparse expert routing architecture', category: 'architecture' },
        ],
        'model-family': [
            { slug: 'llama-family', title: 'Llama Model Family', description: 'Meta open-source LLM family', category: 'model-family' },
        ]
    };
}
