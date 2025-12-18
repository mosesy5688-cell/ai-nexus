import fs from 'fs';
import { CONFIG } from './pp-config.js';

export function generateRankings(models) {
    console.log('🏆 Generating rankings.json...');

    const hot = [...models].sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 100);
    const trending = [...models].sort((a, b) => (b.downloads || 0) - (a.downloads || 0)).slice(0, 100);
    const newModels = [...models].sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()).slice(0, 100);
    const rising = models.filter(m => m.is_rising_star).sort((a, b) => b.velocity - a.velocity).slice(0, 100);

    const rankings = {
        hot,
        trending,
        new: newModels,
        rising
    };

    fs.writeFileSync(CONFIG.RANKINGS_PATH, JSON.stringify(rankings, null, 2));
}

export function createSearchIndex(models) {
    console.log('🔍 Generating search-index.json...');
    const index = models.map(m => ({
        id: m.id,
        slug: m.slug,
        name: m.name,
        author: m.author,
        description: m.description,
        tags: m.tags,
        likes: m.likes,
        downloads: m.downloads,
        is_rising_star: m.is_rising_star,
        source: m.source
    }));
    fs.writeFileSync(CONFIG.SEARCH_INDEX_PATH, JSON.stringify(index, null, 2));
}
