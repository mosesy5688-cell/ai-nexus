/**
 * V27.58: 2-char prefix bucket fetch + isolate-local FIFO cache.
 * Companion to term-index-engine.ts. Kept separate to honor CES Art 5.1.
 *
 * OOM defense: a 40-60KB zstd bucket decompresses to ~400KB raw JSON; V8
 * inflates Map<string,TermData> 4-8× → 1.6-3.2MB heap/bucket. Unbounded
 * growth on a long-lived isolate hits the Worker 128MB ceiling (error 1102).
 * 32 buckets ≈ 100MB worst case; covers spatial locality of multi-term queries.
 */
import { decompress } from 'fzstd';

export type Posting = [string, number, number];
export interface TermData {
    term: string;
    df: number;
    postings: Posting[];
    chunk?: number;
    chunks?: number;
}

const MAX_CACHED_BUCKETS = 32;
const bucketCache = new Map<string, Map<string, TermData> | null>();

function cacheBucket(prefix: string, m: Map<string, TermData> | null): void {
    if (bucketCache.size >= MAX_CACHED_BUCKETS) {
        const oldest = bucketCache.keys().next().value;
        if (oldest !== undefined) bucketCache.delete(oldest);
    }
    bucketCache.set(prefix, m);
}

/**
 * Fetch a 2-char prefix bucket containing all df ≤ HIGH_FREQ_THRESHOLD terms.
 * Returns Map<term, TermData> on success, null on 404 / decode failure.
 * Negative results are also cached to avoid retry storms.
 */
export async function fetchPrefixBucket(
    prefix: string, r2Bucket: any, isDev: boolean
): Promise<Map<string, TermData> | null> {
    if (bucketCache.has(prefix)) return bucketCache.get(prefix) ?? null;
    const key = `data/term_index/${prefix}/_bucket.json.zst`;
    try {
        let compressed: Uint8Array;
        if (r2Bucket && !isDev) {
            const obj = await r2Bucket.get(key);
            if (!obj) { cacheBucket(prefix, null); return null; }
            compressed = new Uint8Array(await obj.arrayBuffer());
        } else {
            const res = await fetch(`https://cdn.free2aitools.com/${key}`);
            if (!res.ok) { cacheBucket(prefix, null); return null; }
            compressed = new Uint8Array(await res.arrayBuffer());
        }
        const envelope = JSON.parse(new TextDecoder().decode(decompress(compressed)));
        const termMap = new Map<string, TermData>();
        for (const [term, data] of Object.entries(envelope.terms || {})) {
            const d = data as { df: number; postings: Posting[] };
            termMap.set(term, { term, df: d.df, postings: d.postings });
        }
        cacheBucket(prefix, termMap);
        return termMap;
    } catch (err: any) {
        console.error(`[Term Index] fetchPrefixBucket("${prefix}") key=${key} failed: ${err?.message || err}`);
        cacheBucket(prefix, null);
        return null;
    }
}
