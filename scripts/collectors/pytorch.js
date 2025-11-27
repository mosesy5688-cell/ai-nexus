import axios from 'axios';

export async function collect() {
    console.log("[PyTorch] Starting collection...");
    try {
        // PyTorch Hub API is free and requires no key.
        const { data } = await axios.get('https://pytorch.org/hub/api');

        // Get the top 10 most starred models
        const models = data.sort((a, b) => b.stars - a.stars).slice(0, 10);

        // Normalize to match the schema expected by Rust optimizer
        const normalized = models.map(m => ({
            id: `pytorch/${m.repo}_${m.name}`, // Construct a unique ID
            name: m.name,
            author: m.repo, // Use repo owner as author
            description: m.description,
            likes: m.stars,
            downloads: 0, // Not available from this API
            tags: ['pytorch'],
            pipeline_tag: 'other', // Default
            source: 'pytorch', // Source tag
            source_url: `https://pytorch.org/hub/${m.repo}_${m.name}`
        }));

        console.log(`[PyTorch] Collected ${normalized.length} models.`);
        return normalized;
    } catch (e) {
        console.error('[PyTorch] Error collecting data:', e.message);
        return [];
    }
}
