import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
dotenv.config();

const CONFIG = {
    ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    BUCKET: process.env.R2_BUCKET || 'ai-nexus-assets'
};

async function listR2() {
    console.log('🕵️ Forensic Discovery: Listing R2 objects...');

    const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${CONFIG.ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: CONFIG.ACCESS_KEY_ID,
            secretAccessKey: CONFIG.SECRET_ACCESS_KEY
        }
    });

    const prefixes = ['cache/entities/model/', 'cache/entities/paper/'];

    for (const prefix of prefixes) {
        console.log(`\n--- ${prefix} ---`);
        const command = new ListObjectsV2Command({
            Bucket: CONFIG.BUCKET,
            Prefix: prefix,
            MaxKeys: 10
        });

        try {
            const response = await s3.send(command);
            (response.Contents || []).forEach(obj => {
                console.log(`- ${obj.Key}`);
            });
            if (!response.Contents) console.log('  (Empty)');
        } catch (err) {
            console.error(`  ❌ Error: ${err.message}`);
        }
    }
}

listR2().catch(console.error);
