import fs from 'fs';
import { CONFIG } from './pp-config.js';

export function calculateVelocity(model) {
    const now = new Date();
    const createdAt = new Date(model.last_updated || new Date());
    const ageInDays = Math.max((now - createdAt) / (1000 * 60 * 60 * 24), 1);

    const likes = model.likes || 0;
    const downloads = model.downloads || 0;

    // Velocity = likes/day + (downloads/day / 10)
    return (likes / ageInDays) + (downloads / ageInDays / 10);
}

export function assignTagsAndStandardize(models) {
    console.log('🏷️ Standardizing tags...');
    const categories = JSON.parse(fs.readFileSync(CONFIG.CATEGORIES_PATH, 'utf-8'));
    const categoryKeywords = new Map();

    // Build lookup map
    categories.flatMap(g => g.items).forEach(cat => {
        categoryKeywords.set(cat.slug.toLowerCase(), cat.slug);
        categoryKeywords.set(cat.title.toLowerCase(), cat.slug);
    });

    // Add merge map
    for (const [key, value] of Object.entries(CONFIG.KEYWORD_MERGE_MAP)) {
        if (categoryKeywords.has(value.toLowerCase())) {
            categoryKeywords.set(key.toLowerCase(), value);
        }
    }

    models.forEach(model => {
        const modelTags = new Set(model.tags || []);
        const description = (model.description || '').toLowerCase();

        // Standardize existing tags
        const newTags = new Set();
        modelTags.forEach(tag => {
            if (categoryKeywords.has(tag.toLowerCase())) {
                newTags.add(categoryKeywords.get(tag.toLowerCase()));
            } else {
                newTags.add(tag); // Keep original if no mapping
            }
        });

        // Extract from description
        for (const [title, slug] of categoryKeywords.entries()) {
            if (description.includes(title)) {
                newTags.add(slug);
            }
        }

        model.tags = Array.from(newTags);
    });

    return models;
}

export function generateKeywords(models) {
    console.log('🔑 Generating keywords.json...');
    const categories = JSON.parse(fs.readFileSync(CONFIG.CATEGORIES_PATH, 'utf-8'));
    const categoryCounts = {};

    categories.forEach(group => {
        group.items.forEach(item => {
            categoryCounts[item.slug] = { ...item, count: 0 };
        });
    });

    models.forEach(model => {
        (model.tags || []).forEach(tag => {
            if (categoryCounts[tag]) {
                categoryCounts[tag].count++;
            }
        });
    });

    const validatedKeywords = Object.values(categoryCounts)
        .filter(cat => cat.count > 0)
        .sort((a, b) => b.count - a.count);

    fs.writeFileSync(CONFIG.KEYWORDS_OUTPUT_PATH, JSON.stringify(validatedKeywords, null, 2));
    return validatedKeywords;
}

export function calculateScoresAndRisingStars(models) {
    console.log('⭐ Calculating scores and rising stars...');
    models.forEach(model => {
        model.velocity = calculateVelocity(model);

        // Popularity Score (simple weighted sum)
        model.popularity_score = (model.likes || 0) * 2 + (model.downloads || 0) * 0.1;
    });

    // Determine Rising Stars (Top 5% by velocity)
    const sortedByVelocity = [...models].sort((a, b) => b.velocity - a.velocity);
    const thresholdIndex = Math.floor(models.length * 0.05);
    const thresholdVelocity = sortedByVelocity[thresholdIndex]?.velocity || 0;

    models.forEach(model => {
        model.is_rising_star = model.velocity >= thresholdVelocity && model.velocity > 0.1; // Min velocity check
    });

    return models;
}

export function calculateRelatedModels(models) {
    console.log('🔗 Calculating related models...');
    // Simple tag overlap similarity
    const modelTagSets = models.map(m => ({ id: m.id, tags: new Set(m.tags || []) }));

    models.forEach((model, idx) => {
        const myTags = modelTagSets[idx].tags;
        if (myTags.size === 0) return;

        const scores = models
            .map((other, otherIdx) => {
                if (idx === otherIdx) return null;
                const otherTags = modelTagSets[otherIdx].tags;
                let overlap = 0;
                myTags.forEach(t => { if (otherTags.has(t)) overlap++; });
                return { id: other.id, score: overlap };
            })
            .filter(x => x && x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map(x => x.id);

        model.related_ids = scores;
    });
    return models;
}
