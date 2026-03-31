/**
 * V∞ Phase 1A-γ: Term Index Engine (SSR)
 * Fetches static inverted index files from R2/CDN, decompresses, merges postings.
 * Each term file is tiny (~600B avg) — use R2 .get() full read, NOT Range Read.
 */
import { decompress } from 'fzstd';
import { tokenizeQuery, termPrefix } from '../utils/search-tokenizer.js';

type Posting = [string, number, number]; // [umid, score, shard_slot]
interface TermData {
    term: string;
    df: number;
    postings: Posting[];
    chunk?: number;
    chunks?: number;
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
    } catch {
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
    } catch {
        return null;
    }
}

/**
 * Fetch postings for all query terms in parallel.
 * Falls back to high-freq chunked format if standard file not found.
 */
export async function fetchAllTermPostings(
    query: string, r2Bucket: any, isDev: boolean
): Promise<{ terms: string[]; results: Map<string, TermData> }> {
    const terms = tokenizeQuery(query);
    if (terms.length === 0) return { terms: [], results: new Map() };

    const results = new Map<string, TermData>();
    const fetches = terms.map(async (term) => {
        let data = await fetchTermFile(term, r2Bucket, isDev);
        if (!data) data = await fetchHighFreqTerm(term, r2Bucket, isDev);
        if (data) results.set(term, data);
    });

    await Promise.all(fetches);
    return { terms, results };
}

/**
 * Merge postings from multiple terms into a ranked candidate list.
 * Multi-term: entities matching more terms score higher (soft intersection).
 * @returns Sorted array of { umid, score, shard } limited to topK.
 */
export function mergePostings(
    termResults: Map<string, TermData>, termCount: number, topK: number = 200
): { umid: string; score: number; shard: number }[] {
    if (termResults.size === 0) return [];

    // Accumulate scores per UMID across all matched terms
    const scoreMap = new Map<string, { score: number; shard: number; hits: number }>();

    for (const [, data] of termResults) {
        for (const [umid, score, shard] of data.postings) {
            const existing = scoreMap.get(umid);
            if (existing) {
                existing.score += score;
                existing.hits++;
            } else {
                scoreMap.set(umid, { score, shard, hits: 1 });
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
