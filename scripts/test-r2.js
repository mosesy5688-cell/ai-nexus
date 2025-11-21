import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function testR2Connection() {
    console.log("🔍 Testing R2 Connection...");

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
        console.error("❌ Missing R2 credentials in .env file.");
        console.log("Required: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY");
        return;
    }

    const S3 = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey,
        },
    });

    try {
        const data = await S3.send(new ListBucketsCommand({}));
        console.log("✅ Connection Successful!");
        console.log("📦 Buckets found:");
        if (data.Buckets && data.Buckets.length > 0) {
            data.Buckets.forEach(bucket => {
                console.log(` - ${bucket.Name}`);
            });
        } else {
            console.log(" - No buckets found (but connection works).");
        }
    } catch (err) {
        console.error("❌ Connection Failed:", err.message);
        if (err.name === 'InvalidAccessKeyId') {
            console.error("👉 Check your R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.");
        }
    }
}

testR2Connection();
