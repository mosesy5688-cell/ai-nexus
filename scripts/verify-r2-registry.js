import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';
import zlib from 'zlib';

async function verifyRegistry() {
    const config = {
        accountId: process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        bucket: process.env.R2_BUCKET || 'ai-nexus-assets'
    };

    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
        console.error('❌ Missing R2 credentials in .env');
        return;
    }

    const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        }
    });

    const prefix = 'meta/backup/registry/';
    console.log(`🔍 Auditing R2 Registry Shards...`);

    try {
        const response = await s3.send(new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix
        }));

        const shards = (response.Contents || [])
            .filter(item => item.Key.endsWith('.json.gz'))
            .sort((a, b) => a.Key.localeCompare(b.Key));

        if (shards.length > 0) {
            console.log(`📦 Found ${shards.length} shards in backup.`);

            // Download the first shard to check metadata
            console.log(`📡 Downloading ${shards[0].Key} for deep inspection...`);
            const getObj = await s3.send(new GetObjectCommand({
                Bucket: config.bucket,
                Key: shards[0].Key
            }));

            const streamToBuffer = (stream) => new Promise((resolve, reject) => {
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('error', reject);
                stream.on('end', () => resolve(Buffer.concat(chunks)));
            });

            const buffer = await streamToBuffer(getObj.Body);
            const decompressed = zlib.gunzipSync(buffer);
            const data = JSON.parse(decompressed.toString('utf-8'));

            console.log('\n💎 Shard Metadata (part-000):');
            console.log(`- Entities in this shard: ${data.entities?.length || data.count}`);
            console.log(`- Reported Part Index: ${data.part}`);
            console.log(`- Reported Total Shards: ${data.total}`);
            console.log(`- Last Updated: ${data.lastUpdated}`);

            const estimatedTotal = (data.entities?.length || 5000) * (data.total || shards.length);
            console.log(`📊 Estimated Total Registry Size: ~${estimatedTotal} entities`);

            if (shards.length === data.total) {
                console.log('✅ SHARD COUNT MATCHES METADATA.');
            } else {
                console.log(`❌ SHARD COUNT MISMATCH: Found ${shards.length}, Expected ${data.total}`);
            }
        }

        // Secondary check: look for monoliths
        console.log('\n🔎 Searching for global-registry monoliths...');
        const rootList = await s3.send(new ListObjectsV2Command({
            Bucket: config.bucket,
            MaxKeys: 100
        }));
        const monoliths = (rootList.Contents || []).filter(c => c.Key.includes('registry') && c.Key.endsWith('.gz'));
        monoliths.forEach(m => console.log(`- Found: ${m.Key} (${(m.Size / 1024 / 1024).toFixed(2)} MB)`));

    } catch (e) {
        console.error('❌ Error:', e.message);
    }
}

verifyRegistry();
