import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
dotenv.config();

const CONFIG = {
    ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    BUCKET: process.env.R2_BUCKET || 'ai-nexus-assets'
};

async function checkSpecificFiles() {
    console.log('🎯 Surgical R2 Search: Searching for specific image files...');

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

    const targetKeys = [
        'images/model/deepseek-ai--DeepSeek-R1.webp',
        'images/model/black-forest-labs--FLUX.1-dev.webp',
        'data/images/model/deepseek-ai--DeepSeek-R1.webp',
        'output/images/model/deepseek-ai--DeepSeek-R1.webp',
        'images/space/jbilcke-hf--ai-clip-factory.webp'
    ];

    for (const key of targetKeys) {
        try {
            const res = await s3.send(new HeadObjectCommand({
                Bucket: CONFIG.BUCKET,
                Key: key
            }));
            console.log(`✅ FOUND: ${key} (${res.ContentLength} bytes, Type: ${res.ContentType})`);
        } catch (e) {
            console.log(`❌ NOT FOUND: ${key} (${e.name === 'NotFound' ? 'DoesNotExist' : e.message})`);
        }
    }
}

checkSpecificFiles();
