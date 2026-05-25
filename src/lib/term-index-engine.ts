/**
 * V∞ Phase 1A-γ: Term Index Engine (SSR)
 * Fetches static inverted index files from R2/CDN, decompresses, merges postings.
 * Each term file is tiny (~600B avg) — use R2 .get() full read, NOT Range Read.
 */
import { decompress } from 'fzstd';
import { tokenizeQuery, termPrefix } from '../utils/search-tokenizer.js';
import { fetchPrefixBucket, type Posting, type TermData } from './term-index-bucket-cache.js';

interface TermIndexManifest {
    total_docs: number;
    avg_doc_length: number;
    version: string;
}

let cachedManifest: TermIndexManifest | null = null;

/** Fetch term_index manifest from R2 (cached per isolate lifetime) */
async function fetchManifest(r2Bucket: any, isDev: boolean): Promise<TermIndexManifest | null> {
    if (cachedManifest) return cachedManifest;
    const key = 'data/term_index/_manifest.json.zst';
    try {
        let compressed: Uint8Array;
        if (r2Bucket && !isDev) {
            const obj = await r2Bucket.get(key);
            if (!obj) return null;
            compressed = new Uint8Array(await obj.arrayBuffer());
        } else {
            const res = await fetch(`https://cdn.free2aitools.com/${key}`);
            if (!res.ok) return null;
            compressed = new Uint8Array(await res.arrayBuffer());
        }
        const parsed = JSON.parse(new TextDecoder().decode(decompress(compressed)));
        cachedManifest = {
            total_docs: parsed.total_docs,
            avg_doc_length: parsed.avg_doc_length,
            version: parsed.version || 'inverted_v1',
        };
        return cachedManifest;
    } catch (err: any) {
        console.error(`[Term Index] fetchManifest failed: ${err?.message || err}`);
        return null;
    }
}

/** Fetch a single term's posting list from R2 (with CDN fallback for dev) */
async function fetchTermFile(term: string, r2Bucket: any, isDev: boolean): Promise<TermData | null> {
    const prefix = termPrefix(term);
    const key = `data/term_index/${prefix}/${term}.json.zst`;

    try {
        let compressed: Uint8Array;
        if (r2Bucket && !isDev) {
            const obj = await r2Bucket.get(key);
            if (!obj) return null;
            compressed = new Uint8Array(await obj.arrayBuffer());
        } else {
            const res = await fetch(`https://cdn.free2aitools.com/${key}`);
            if (!res.ok) return null;
            compressed = new Uint8Array(await res.arrayBuffer());
        }
        const decompressed = decompress(compressed);
        return JSON.parse(new TextDecoder().decode(decompressed));
    } catch (err: any) {
        console.error(`[Term Index] fetchTermFile("${term}") key=${key} failed: ${err?.message || err}`);
        return null;
    }
}

/** Fetch high-frequency term chunks (term_0.json.zst, term_1.json.zst, ...) */
async function fetchHighFreqTerm(
    term: string, r2Bucket: any, isDev: boolean
): Promise<TermData | null> {
    // Try chunk 0 first to discover total chunks
    const prefix = termPrefix(term);
    const key0 = `data/term_index/${prefix}/${term}_0.json.zst`;

    try {
        let compressed: Uint8Array;
        if (r2Bucket && !isDev) {
            const obj = await r2Bucket.get(key0);
            if (!obj) return null;
            compressed = new Uint8Array(await obj.arrayBuffer());
        } else {
            const res = await fetch(`https://cdn.free2aitools.com/${key0}`);
            if (!res.ok) return null;
            compressed = new Uint8Array(await res.arrayBuffer());
        }
        const chunk0: TermData = JSON.parse(new TextDecoder().decode(decompress(compressed)));
        // For search, chunk 0 (top scores) is sufficient — skip loading all chunks
        return { term, df: chunk0.df, postings: chunk0.postings };
    } catch (err: any) {
        console.error(`[Term Index] fetchHighFreqTerm("${term}") key=${key0} failed: ${err?.message || err}`);
        return null;
    }
}

/**
 * Fetch postings for all query terms in parallel.
 * Falls back to high-freq chunked format if standard file not found.
 */
export async function fetchAllTermPostings(
    query: string, r2Bucket: any, isDev: boolean
): Promise<{ terms: string[]; results: Map<string, TermData>; manifest: TermIndexManifest | null }> {
    const terms = tokenizeQuery(query);
    if (terms.length === 0) return { terms: [], results: new Map(), manifest: null };

    const results = new Map<string, TermData>();
    // V27.58: manifest must be fetched first so we know whether to try v2 bucket path.
    const manifest = await fetchManifest(r2Bucket, isDev);
    const useV2Bucket = manifest?.version === 'inverted_v2_bucketed';

    let v1FallbackHits = 0;  // observability — should reach 0 after cron N+1, gate for follow-up cleanup PR
    await Promise.all(terms.map(async (term) => {
        // Tier 1: high-frequency chunked file (unchanged across v1/v2)
        let data = await fetchHighFreqTerm(term, r2Bucket, isDev);
        // Tier 2 (v2 only): prefix bucket. Also covers Cron N boundary race —
        // bucket file present (200 OK) but builder still streaming, in-progress
        // bucket may not yet contain a very cold term → bucket.has(term)===false.
        // Must fall through to v1 legacy, NOT only on bucket-fetch-failure.
        if (!data && useV2Bucket) {
            const bucket = await fetchPrefixBucket(termPrefix(term), r2Bucket, isDev);
            if (bucket && bucket.has(term)) data = bucket.get(term) ?? null;
        }
        // Tier 3: v1 individual file (legacy fallback during cron-N transition).
        if (!data) {
            data = await fetchTermFile(term, r2Bucket, isDev);
            if (data && useV2Bucket) v1FallbackHits++;
        }
        if (data) results.set(term, data);
    }));

    const found = [...results.keys()];
    const missed = terms.filter(t => !results.has(t));
    if (missed.length > 0) {
        console.warn(`[Term Index] query="${query}" terms=${terms.length} found=[${found.join(',')}] missed=[${missed.join(',')}]`);
    }
    if (v1FallbackHits > 0) {
        console.warn(`[Term Index] v1-legacy-fallback fired ${v1FallbackHits}/${terms.length} times — expected 0 after cron N+1.`);
    }

    return { terms, results, manifest };
}

/**
 * Merge postings from multiple terms into a ranked candidate list.
 * Multi-term: entities matching more terms score higher (soft intersection).
 * @returns Sorted array of { umid, score, shard } limited to topK.
 */
export function mergePostings(
    termResults: Map<string, TermData>, termCount: number, topK: number = 200,
    manifest: TermIndexManifest | null = null
): { umid: string; score: number; shard: number }[] {
    if (termResults.size === 0) return [];

    const totalDocs = manifest?.total_docs ?? 0;
    const avgDl = manifest?.avg_doc_length ?? 1;
    const k1 = 1.2, b = 0.75;

    // Accumulate scores per UMID across all matched terms
    const scoreMap = new Map<string, { score: number; shard: number; hits: number }>();

    for (const [, data] of termResults) {
        // Query-time BM25: idf from df + manifest globals (graceful degradation: pure FNI if no manifest)
        const df = data.df;
        const idf = totalDocs > 0 ? Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1) : 0;
        const bm25 = idf * (k1 + 1) / (1 + k1 * (1 - b + b / avgDl)); // tf=1, dl=1

        for (const [umid, fniScore, shard] of data.postings) {
            const blended = totalDocs > 0
                ? Math.round((fniScore * 0.6 + bm25 * 40 * 0.4) * 100) / 100
                : fniScore;
            const existing = scoreMap.get(umid);
            if (existing) {
                existing.score += blended;
                existing.hits++;
            } else {
                scoreMap.set(umid, { score: blended, shard, hits: 1 });
            }
        }
    }

    // Boost entities that match ALL terms (coverage bonus)
    const candidates: { umid: string; score: number; shard: number }[] = [];
    for (const [umid, entry] of scoreMap) {
        const coverageBoost = termCount > 1 ? (entry.hits / termCount) : 1;
        candidates.push({ umid, score: entry.score * coverageBoost, shard: entry.shard });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topK);
}

/** Group candidates by shard slot for batch hydration */
export function groupByShard(candidates: { umid: string; shard: number }[]): Map<number, string[]> {
    const groups = new Map<number, string[]>();
    for (const c of candidates) {
        let list = groups.get(c.shard);
        if (!list) { list = []; groups.set(c.shard, list); }
        list.push(c.umid);
    }
    return groups;
}
