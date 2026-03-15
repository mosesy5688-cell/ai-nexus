
import { createR2Client } from './lib/r2-helpers.js';
import { ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

const R2_BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';

async function locateMonoliths() {
    const s3 = createR2Client();
    const potentialPaths = [
        'meta/backup/global-registry.json.gz',
        'meta/backup/merged.json.gz',
        'data/merged.json.gz',
        'checkpoint.json'
    ];

    console.log('🔍 Locating Monoliths...');
    for (const path of potentialPaths) {
        try {
            const res = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: path }));
            console.log(`  - ${path.padEnd(40)} | ${(res.ContentLength / 1024 / 1024).toFixed(2)} MB`);
        } catch (e) {
            // console.log(`  - ${path.padEnd(40)} | MISSING`);
        }
    }

    console.log('\n🔍 Listing all objects in meta/backup/registry/ (Sampling)...');
    try {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'meta/backup/registry/', MaxKeys: 10 }));
        for (const obj of res.Contents || []) {
            console.log(`  - ${obj.Key.padEnd(50)} | ${(obj.Size / 1024 / 1024).toFixed(2)} MB`);
        }
    } catch (e) {}
}

locateMonoliths().catch(console.error);
