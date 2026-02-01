import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
dotenv.config();

const CONFIG = {
    ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    BUCKET: process.env.R2_BUCKET || 'ai-nexus-assets'
};

async function verifyR2() {
    console.log('🔍 Truth Audit: Verifying R2 Entity Identity Standard...');

    const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${CONFIG.ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: CONFIG.ACCESS_KEY_ID,
            secretAccessKey: CONFIG.SECRET_ACCESS_KEY
        }
    });

    const probes = [
        'cache/entities/model/meta-llama--Llama-3-8b.json',
        'cache/entities/model/hf-model--meta-llama--Llama-3-8b.json',
        'cache/entities/agent/gh-agent--gpt-author--mcp-server.json',
        'cache/entities/agent/hf-agent--gpt-author--mcp-server.json',
        'cache/entities/paper/arxiv--2302.13971.json',
        'cache/entities/paper/arxiv-paper--2302.13971.json',
        'cache/entities/space/hf-space--llava-vl--llava-interactive.json'
    ];

    for (const key of probes) {
        try {
            await s3.send(new HeadObjectCommand({ Bucket: CONFIG.BUCKET, Key: key }));
            console.log(`✅ EXIST: ${key}`);
        } catch (e) {
            console.log(`❌ MISS : ${key}`);
        }
    }
}

verifyR2().catch(console.error);
