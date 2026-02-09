import fs from 'fs/promises';
import path from 'path';

async function main() {
    const outputDir = './output';
    const healthDir = path.join(outputDir, 'meta', 'health');
    const today = new Date().toISOString().split('T')[0];
    const pulseFile = path.join(healthDir, `pulse-${today}.json.gz`);

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

        const shardHealthPath = path.join(healthDir, `${today}.json.gz`);
        try {
            let data = await fs.readFile(shardHealthPath);
            if (data[0] === 0x1f && data[1] === 0x8b) {
                const zlib = await import('zlib');
                data = zlib.gunzipSync(data);
            }
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

        const zlib = await import('zlib');
        await fs.writeFile(pulseFile, zlib.gzipSync(JSON.stringify(pulse, null, 2)));
        console.log(`✅ [HEALTH] Factory Pulse generated: ${pulseFile} (Compressed)`);
    } catch (e) {
        console.error(`❌ [HEALTH] Consolidation failed: ${e.message}`);
    }
}

main().catch(console.error);
