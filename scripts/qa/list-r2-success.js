import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
dotenv.config();

const CONFIG = {
    ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    BUCKET: process.env.R2_BUCKET || 'ai-nexus-assets'
};

async function verifySuccessCases() {
    console.log('✅ Truth Audit: Verifying successful standard-compliant entities...');

    const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${CONFIG.ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: CONFIG.ACCESS_KEY_ID,
            secretAccessKey: CONFIG.SECRET_ACCESS_KEY
        }
    });

    const prefixes = ['cache/entities/dataset/', 'cache/entities/space/'];

    for (const prefix of prefixes) {
        console.log(`\n--- ${prefix} ---`);
        const command = new ListObjectsV2Command({
            Bucket: CONFIG.BUCKET,
            Prefix: prefix,
            MaxKeys: 5
        });

        try {
            const response = await s3.send(command);
            (response.Contents || []).forEach(obj => {
                console.log(`- ${obj.Key}`);
            });
        } catch (err) {
            console.error(`  ❌ Error: ${err.message}`);
        }
    }
}

verifySuccessCases().catch(console.error);
