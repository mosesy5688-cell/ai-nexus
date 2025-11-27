import path from 'path';

// Configuration
const HF_API_URL = "https://huggingface.co/api/models?sort=likes&direction=-1&limit=100&full=true";
const PROXY_URL = process.env.CF_PROXY_URL; // Optional proxy

export async function collect() {
    console.log("[HuggingFace] Starting collection...");

    let url = HF_API_URL;
    if (PROXY_URL) {
        console.log(`[HuggingFace] Using proxy: ${PROXY_URL}`);
        url = `${PROXY_URL}?target=${encodeURIComponent(HF_API_URL)}`;
    }

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        // Normalize and tag data
        const normalized = data.map(item => ({
            ...item,
            source: 'huggingface'
        }));

        console.log(`[HuggingFace] Collected ${normalized.length} models.`);
        return normalized;
    } catch (error) {
        console.error("[HuggingFace] Error collecting data:", error);
        return []; // Return empty array on failure to not break the whole pipeline
    }
}
