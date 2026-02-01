import fs from 'fs';
import path from 'path';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';
import { loadGlobalRegistry } from './lib/cache-manager.js';

async function main() {
    const dataDir = process.argv[2] || 'data';
    const queuePath = 'data/image-queue.json';
    const batchSize = parseInt(process.argv[3] || '2000', 10);

    // Set CACHE_DIR to the provided directory (e.g. data/ or output/meta/backup/)
    process.env.CACHE_DIR = dataDir;

    console.log(`[IMAGE-PREP] Loading registry from ${dataDir}...`);
    const registry = await loadGlobalRegistry();
    const entities = registry.entities || [];

    if (entities.length === 0) {
        console.error('❌ Registry is empty or missing');
        process.exit(1);
    }

    console.log('📊 Registry loaded:', entities.length, 'entities');

    // Extract image URLs needing processing (Prioritize by FNI score)
    const imageUrls = entities.filter(e => e.image_url && !e.image_url.includes('free2aitools.com'))
        .sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0))
        .slice(0, batchSize)
        .map(e => {
            const cleanId = normalizeId(e.id, getNodeSource(e.id, e.type), e.type);
            return {
                id: cleanId,
                source_url: e.image_url,
                type: e.type || 'model'
            };
        });

    if (!fs.existsSync(path.dirname(queuePath))) {
        fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    }

    fs.writeFileSync(queuePath, JSON.stringify(imageUrls, null, 2));
    console.log('✅ Image queue created:', imageUrls.length, 'tasks');
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
