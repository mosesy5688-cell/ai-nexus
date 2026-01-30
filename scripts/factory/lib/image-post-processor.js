import fs from 'fs';
import path from 'path';

/**
 * Image Post-Processor V16.4.4
 * Updates registry.json with local CDN URLs after successful R2 upload
 */

async function main() {
    const registryPath = process.argv[2] || 'data/registry.json';
    const resultsPath = process.argv[3] || 'data/image-results.json';
    const imagesDir = 'data/images';
    const CDN_BASE = 'https://cdn.free2aitools.com/images';

    if (!fs.existsSync(registryPath)) {
        console.error('❌ Registry not found:', registryPath);
        process.exit(1);
    }

    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const entities = registry.entities || [];

    console.log(`🔄 Post-processing ${entities.length} entities...`);

    let updatedCount = 0;

    // Scan data/images for successfully processed WebP files
    // Structure: data/images/{type}/{id}.webp
    if (!fs.existsSync(imagesDir)) {
        console.log('ℹ️ No images directory found. Skipping registry update.');
        process.exit(0);
    }

    const types = fs.readdirSync(imagesDir).filter(f => fs.statSync(path.join(imagesDir, f)).isDirectory());

    for (const type of types) {
        const files = fs.readdirSync(path.join(imagesDir, type)).filter(f => f.endsWith('.webp'));
        const processedIds = new Set(files.map(f => f.replace('.webp', '')));

        for (const entity of entities) {
            const entityType = entity.type || 'model';
            if (entityType !== type) continue;

            const safeId = (entity.id || entity.slug || '').replace(/[/:]/g, '--');

            if (processedIds.has(safeId)) {
                const newUrl = `${CDN_BASE}/${type}/${safeId}.webp`;
                if (entity.image_url !== newUrl) {
                    entity.image_url = newUrl;
                    updatedCount++;
                }
            }
        }
    }

    if (updatedCount > 0) {
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
        console.log(`✅ Updated ${updatedCount} entities in registry with CDN URLs.`);
    } else {
        console.log('ℹ️ No registry updates needed.');
    }
}

main().catch(console.error);
