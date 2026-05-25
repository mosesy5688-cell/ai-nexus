/**
 * V27.58: Prefix-bucket writer for the inverted index.
 * Collapses ~99% of unique terms (df ≤ HIGH_FREQ_THRESHOLD) into one
 * `_bucket.json.zst` per 2-char prefix, eliminating the ~382K-files-per-cron
 * Class A storm and the 256B BLOCKED false-positive class on long-tail terms.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { zstdCompress } from './zstd-helper.js';

/**
 * Write one `_bucket.json.zst` per accumulated 2-char prefix.
 * @param {Map<string, Object<string,{df:number,postings:any[]}>>} bucketAccum
 * @param {string} outputDir
 * @returns {{ bucketsWritten: number, bucketBytes: number, maxBucketBytes: number, maxBucketPrefix: string }}
 */
export async function writeBucketAccum(bucketAccum, outputDir) {
    let bucketsWritten = 0, bucketBytes = 0, maxBucketBytes = 0, maxBucketPrefix = '';
    for (const [prefix, terms] of bucketAccum) {
        const envelope = {
            version: 'inverted_v2_bucketed',
            prefix,
            term_count: Object.keys(terms).length,
            terms,
        };
        const compressed = await zstdCompress(Buffer.from(JSON.stringify(envelope)), 3);
        writeFileSync(join(outputDir, prefix, `_bucket.json.zst`), compressed);
        bucketsWritten++;
        bucketBytes += compressed.length;
        if (compressed.length > maxBucketBytes) {
            maxBucketBytes = compressed.length;
            maxBucketPrefix = prefix;
        }
    }
    return { bucketsWritten, bucketBytes, maxBucketBytes, maxBucketPrefix };
}
