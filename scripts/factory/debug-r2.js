import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client } from './lib/r2-helpers.js';
import 'dotenv/config';

const getR2Bucket = () => process.env.R2_BUCKET || 'ai-nexus-assets';

async function debugR2() {
    const s3 = createR2Client();
    if (!s3) {
        console.error('R2 Client could not be created. Check environment variables.');
        return;
    }

    const filesToCheck = [
        'cache/mesh/graph.json',
        'cache/relations.json',
        'cache/relations/explicit.json',
        'cache/relations/knowledge-links.json',
        'cache/knowledge/index.json',
        'cache/reports/index.json',
        'cache/mesh/stats.json'
    ];

    for (const key of filesToCheck) {
        try {
            const head = await s3.send(new HeadObjectCommand({
                Bucket: getR2Bucket(),
                Key: key
            }));
            console.log(`\n✅ Found: "${key}"`);
            console.log(`   - Size: ${(head.ContentLength / 1024).toFixed(1)} KB`);
        } catch (e) {
            console.log(`\n❌ Not Found: "${key}" (${e.message})`);
        }
    }
}

debugR2().catch(console.error);
