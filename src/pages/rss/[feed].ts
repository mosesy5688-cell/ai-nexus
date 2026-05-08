/**
 * RSS Feed Proxy — serves pipeline-generated RSS from R2.
 * Routes: /rss/reports.xml, /rss/knowledge.xml
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const ALLOWED_FEEDS = new Set(['reports.xml', 'knowledge.xml']);

function getR2Client() {
    const accountId = env?.CLOUDFLARE_ACCOUNT_ID || import.meta.env.CLOUDFLARE_ACCOUNT_ID;
    const accessKey = env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID;
    const secretKey = env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKey || !secretKey) return null;
    return new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
}

export const GET: APIRoute = async ({ params }) => {
    const feed = params.feed;
    if (!feed || !ALLOWED_FEEDS.has(feed)) {
        return new Response('Not found', { status: 404 });
    }

    const r2Bucket = env?.R2_ASSETS;
    if (r2Bucket) {
        try {
            const obj = await r2Bucket.get(`rss/${feed}`);
            if (obj) {
                return new Response(obj.body, {
                    headers: {
                        'Content-Type': 'application/rss+xml; charset=utf-8',
                        'Cache-Control': 'public, max-age=3600, s-maxage=7200',
                    },
                });
            }
        } catch {}
    }

    const s3 = getR2Client();
    if (s3) {
        try {
            const bucket = import.meta.env.R2_BUCKET || 'ai-nexus-assets';
            const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `rss/${feed}` }));
            const chunks: Uint8Array[] = [];
            for await (const chunk of resp.Body as any) chunks.push(chunk);
            return new Response(Buffer.concat(chunks), {
                headers: {
                    'Content-Type': 'application/rss+xml; charset=utf-8',
                    'Cache-Control': 'public, max-age=3600, s-maxage=7200',
                },
            });
        } catch {}
    }

    return new Response('Feed not available', { status: 404 });
};
