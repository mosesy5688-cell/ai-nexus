import * as cheerio from 'cheerio';

export async function collect() {
    console.log("[PyTorch] Starting collection from web...");
    try {
        const response = await fetch('https://pytorch.org/hub/');
        const html = await response.text();
        const $ = cheerio.load(html);

        const items = $('.lf-models-item');
        console.log(`[PyTorch] Found ${items.length} model items`);

        const models = [];

        items.each((i, el) => {
            const $el = $(el);
            const titleEl = $el.find('.lf-models-item__title a');
            const name = titleEl.text().trim();
            const source_url = titleEl.attr('href');

            // Description: Try to find a paragraph or summary div
            // Based on typical structure, it might be a p tag or class starting with lf-models-item__
            let description = $el.find('p').text().trim();
            if (!description) {
                // Fallback: try to get text that is not title or meta
                description = $el.text().replace(name, '').trim().substring(0, 200);
            }

            // Stars: Look for a link to github.com
            const githubLink = $el.find('a[href*="github.com"]');
            let likes = 0;
            if (githubLink.length > 0) {
                const starsText = githubLink.text().trim();
                likes = parseStars(starsText);
            }

            if (name && source_url) {
                // Construct ID from the URL path
                // URL: https://pytorch.org/hub/author_repo/
                const parts = source_url.split('/').filter(p => p);
                const slug = parts[parts.length - 1]; // e.g. huggingface_pytorch-transformers

                // Try to split author/repo from slug if possible, or just use slug
                // The slug usually is "author_repo" or "repo"
                let author = "pytorch";
                let repo = slug;

                if (slug.includes('_')) {
                    const split = slug.split('_');
                    author = split[0];
                    repo = split.slice(1).join('_');
                }

                models.push({
                    id: `pytorch/${slug}`,
                    name: name,
                    author: author,
                    description: description,
                    likes: likes,
                    downloads: 0,
                    tags: ['pytorch'],
                    pipeline_tag: 'other',
                    source: 'pytorch',
                    source_url: source_url
                });
            }
        });

        console.log(`[PyTorch] Collected ${models.length} models.`);
        return models;
    } catch (e) {
        console.error('[PyTorch] Error collecting data:', e.message);
        return [];
    }
}

function parseStars(text) {
    if (!text) return 0;
    // Handle "153.1k" -> 153100
    const lower = text.toLowerCase();
    let multiplier = 1;
    if (lower.includes('k')) multiplier = 1000;
    if (lower.includes('m')) multiplier = 1000000;

    const num = parseFloat(lower.replace(/[km]/g, ''));
    return Math.floor(num * multiplier) || 0;
}
