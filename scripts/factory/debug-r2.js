import { ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client } from './lib/r2-helpers.js';
import 'dotenv/config';

const getR2Bucket = () => process.env.R2_BUCKET || 'ai-nexus-assets';

async function debugR2() {
    const s3 = createR2Client();
    if (!s3) {
        console.error('R2 Client could not be created. Check environment variables.');
        return;
    }

    const prefixes = ['cache/rankings/', 'cache/rankings/_type_model/', 'cache/rankings/model/'];

    for (const prefix of prefixes) {
        try {
            console.log(`\n📂 Listing objects with prefix: "${prefix}"`);
            const response = await s3.send(new ListObjectsV2Command({
                Bucket: getR2Bucket(),
                Prefix: prefix,
                MaxKeys: 20
            }));

            if (!response.Contents || response.Contents.length === 0) {
                console.log('   (No objects found)');
                continue;
            }

            for (const obj of response.Contents) {
                console.log(`   - ${obj.Key} (${(obj.Size / 1024).toFixed(1)} KB, modified: ${obj.LastModified})`);
            }
        } catch (e) {
            console.error(`\n❌ Error listing objects for prefix "${prefix}": ${e.message}`);
        }
    }
}

debugR2().catch(console.error);
