import fs from 'fs/promises';
import path from 'path';
import { zstdCompress, autoDecompress } from './lib/zstd-helper.js';

async function main() {
    const outputDir = './output';
    const healthDir = path.join(outputDir, 'meta', 'health');
    const today = new Date().toISOString().split('T')[0];
    const pulseFile = path.join(healthDir, `pulse-${today}.json.zst`);

    console.log('[HEALTH] Consolidating Factory Pulse...');

    try {
        await fs.mkdir(healthDir, { recursive: true });

        // Load existing shard health if it exists
        let pulse = {
            date: today,
            timestamp: new Date().toISOString(),
            tasks: {},
            overallStatus: 'healthy'
        };

        const shardHealthPath = path.join(healthDir, `${today}.json.zst`);
        try {
            let data = await fs.readFile(shardHealthPath);
            data = await autoDecompress(data);
            const shardData = JSON.parse(data.toString('utf-8'));
            pulse = { ...pulse, ...shardData, tasks: {} };
        } catch {
            // No shard health yet
        }

        // Look for task results
        const taskFiles = [
            { id: 'search', name: 'Search Indexing' },
            { id: 'rankings', name: 'Rankings & Categories' },
            { id: 'trending', name: 'Trending Data' },
            { id: 'relations', name: 'Knowledge Mesh' },
            { id: 'sitemap', name: 'Sitemaps' }
        ];

        for (const task of taskFiles) {
            // Task status is inferred from artifact existence or success logs
            // For now, simpler: check if the task specific output was generated
            pulse.tasks[task.id] = {
                name: task.name,
                status: 'pending'
            };
        }

        await fs.writeFile(pulseFile, await zstdCompress(JSON.stringify(pulse, null, 2)));
        console.log(`✅ [HEALTH] Factory Pulse generated: ${pulseFile} (Zstd)`);
    } catch (e) {
        console.error(`❌ [HEALTH] Consolidation failed: ${e.message}`);
        process.exit(1);
    }
}

main().catch(err => { console.error('❌ [HEALTH] Fatal:', err); process.exit(1); });
