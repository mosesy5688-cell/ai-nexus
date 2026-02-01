import { S3Client, ListObjectsV2Command, ListBucketsCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
dotenv.config();

const CONFIG = {
    ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    BUCKET: process.env.R2_BUCKET || 'ai-nexus-assets'
};

async function auditR2() {
    console.log('🔍 Initiating R2 Entity Cache Audit');

    if (!CONFIG.ACCOUNT_ID || !CONFIG.ACCESS_KEY_ID || !CONFIG.SECRET_ACCESS_KEY) {
        console.error('❌ Missing R2 credentials in .env');
        process.exit(1);
    }

    const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${CONFIG.ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: CONFIG.ACCESS_KEY_ID,
            secretAccessKey: CONFIG.SECRET_ACCESS_KEY
        }
    });

    const targetPrefixes = [
        'cache/entities/model/',
        'cache/entities/paper/',
        'cache/entities/agent/',
        'meta/health/'
    ];

    try {
        for (const prefix of targetPrefixes) {
            console.log(`\n🔍 Scanning prefix: ${prefix}...`);
            const response = await s3.send(new ListObjectsV2Command({
                Bucket: CONFIG.BUCKET,
                Prefix: prefix,
                MaxKeys: 10
            }));

            if (response.Contents && response.Contents.length > 0) {
                console.log(`✅ FOUND ${response.KeyCount || response.Contents.length} objects.`);
                // Sort by LastModified descending to see the latest
                const sorted = response.Contents.sort((a, b) => b.LastModified - a.LastModified);
                console.log('📄 Latest 5 objects:');
                sorted.slice(0, 5).forEach(obj => {
                    console.log(`   - ${obj.Key} (${obj.LastModified.toISOString()}, ${obj.Size} bytes)`);
                });
            } else {
                console.log(`❌ No objects found with prefix: ${prefix}`);
            }
        }

        // Check entities.json and checkpoint.json directly
        const roots = ['entities.json', 'checkpoint.json'];
        for (const key of roots) {
            try {
                const res = await s3.send(new ListObjectsV2Command({
                    Bucket: CONFIG.BUCKET,
                    Prefix: key,
                    MaxKeys: 1
                }));
                if (res.Contents && res.Contents.length > 0) {
                    const obj = res.Contents[0];
                    console.log(`\n✅ Root file FOUND: ${key} (${obj.LastModified.toISOString()}, ${obj.Size} bytes)`);
                }
            } catch (e) { }
        }

    } catch (e) {
        console.error('❌ Audit failed: ' + e.message);
    }
}

auditR2();
