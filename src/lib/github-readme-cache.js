/**
 * R2-backed README cache keyed by repo pushedAt.
 *
 * V27.23 layer 3 — without caching, every cron run re-fetches ~10k READMEs
 * from GitHub, multiplying our attack surface on degraded days and burning
 * GitHub goodwill. Most repos don't push between cron cycles, so the same
 * README is re-fetched verbatim 99% of the time.
 *
 * With caching keyed on pushedAt:
 *  - Steady state: only repos that pushed since last cron need a fresh fetch
 *    (typically <15% of catalog), cutting README requests from ~10k to
 *    ~500-1500 per run.
 *  - Fewer requests = less exposure to GitHub's transient backend issues.
 *
 * Storage layout: one R2 object at cache/github-readme/index.ndjson.zst
 * containing one line per repo: {id, pushedAt, readme}. Loaded fully into
 * a Map at run start, mutated in place during the run, serialized back at
 * end. ~10k × ~30KB = ~300MB uncompressed → ~30-60MB zstd compressed; round
 * trip fits comfortably on the runner.
 *
 * Degradation: if R2 client isn't configured (env vars missing) or load
 * fails, we return an empty Map and the run proceeds without caching —
 * functionally identical to V27.23 layer 1+2 alone.
 */

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client } from '../../scripts/factory/lib/r2-helpers.js';
import { zstdCompress, zstdDecompress } from '../../scripts/factory/lib/zstd-helper.js';

const CACHE_KEY = 'cache/github-readme/index.ndjson.zst';
const R2_BUCKET = () => process.env.R2_BUCKET || 'ai-nexus-assets';

export async function loadReadmeCache() {
    const s3 = createR2Client();
    if (!s3) {
        console.log('   [README-CACHE] R2 unavailable — cache disabled');
        return new Map();
    }
    try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET(), Key: CACHE_KEY }));
        const compressed = Buffer.from(await resp.Body.transformToByteArray());
        const decompressed = await zstdDecompress(compressed);
        const text = decompressed.toString('utf-8');
        const cache = new Map();
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                if (entry.id != null && entry.pushedAt) {
                    cache.set(entry.id, { pushedAt: entry.pushedAt, readme: entry.readme || '' });
                }
            } catch {
                // Skip malformed lines silently — single bad line shouldn't abort cache
            }
        }
        console.log(`   [README-CACHE] Loaded ${cache.size} cached READMEs`);
        return cache;
    } catch (err) {
        const isMissing = err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
        if (isMissing) {
            console.log('   [README-CACHE] No cache yet — starting fresh');
        } else {
            console.warn(`   [README-CACHE] Load failed: ${err.message} — starting fresh`);
        }
        return new Map();
    }
}

export async function saveReadmeCache(cache) {
    if (!cache || cache.size === 0) return;
    const s3 = createR2Client();
    if (!s3) {
        console.log('   [README-CACHE] R2 unavailable — skipping cache save');
        return;
    }
    const lines = [];
    for (const [id, entry] of cache) {
        lines.push(JSON.stringify({ id, pushedAt: entry.pushedAt, readme: entry.readme || '' }));
    }
    const ndjson = lines.join('\n');
    const compressed = await zstdCompress(Buffer.from(ndjson, 'utf-8'));
    try {
        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET(),
            Key: CACHE_KEY,
            Body: compressed,
            ContentType: 'application/zstd'
        }));
        const mb = (compressed.length / 1024 / 1024).toFixed(1);
        console.log(`   [README-CACHE] Saved ${cache.size} READMEs (${mb}MB compressed)`);
    } catch (err) {
        console.warn(`   [README-CACHE] Save failed: ${err.message}`);
    }
}

/**
 * Return cached README content if pushedAt matches, else null (miss).
 * Returns empty string '' if we previously confirmed no README exists — that's
 * still a hit (saves a 404 round-trip).
 */
export function checkCache(cache, repoId, currentPushedAt) {
    if (!cache || repoId == null || !currentPushedAt) return null;
    const entry = cache.get(repoId);
    if (!entry || entry.pushedAt !== currentPushedAt) return null;
    return entry.readme;
}

export function updateCache(cache, repoId, pushedAt, readme) {
    if (!cache || repoId == null || !pushedAt) return;
    cache.set(repoId, { pushedAt, readme: readme || '' });
}
