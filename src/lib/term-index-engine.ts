/**
 * V∞ Phase 1A-γ: Term Index Engine (SSR)
 * Fetches static inverted index files from R2/CDN, decompresses, merges postings.
 * Each term file is tiny (~600B avg) — use R2 .get() full read, NOT Range Read.
 */
import { decompress } from 'fzstd';
import { tokenizeQuery, termPrefix } from '../utils/search-tokenizer.js';
import { fetchPrefixBucket, type Posting, type TermData } from './term-index-bucket-cache.js';
import { withOpTimeout } from './op-timeout.js';

interface TermIndexManifest {
    total_docs: number;
    avg_doc_length: number;
    version: string;
}

let cachedManifest: TermIndexManifest | null = null;
let cachedManifestAt = 0;
// V27.60 H3: 60s TTL so daily cron rollover refreshes within 1 min.
// Cost: 1 R2 Class B GET per 60s per isolate (~$0.0000003/min, negligible).
const MANIFEST_TTL_MS = 60_000;

/** Fetch term_index manifest from R2 (60s TTL, falls back to stale on transient err) */
async function fetchManifest(r2Bucket: any, isDev: boolean): Promise<TermIndexManifest | null> {
    if (cachedManifest && (Date.now() - cachedManifestAt) < MANIFEST_TTL_MS) return cachedManifest;
    const key = 'data/term_index/_manifest.json.zst';
    try {
        let compressed: Uint8Array;
        if (r2Bucket && !isDev) {
            const obj = await r2Bucket.get(key);
            if (!obj) return cachedManifest;  // V27.60: 404 → keep stale (better than no manifest)
            compressed = new Uint8Array(await obj.arrayBuffer());
        } else {
            const res = await fetch(`https://cdn.free2aitools.com/${key}`);
            if (!res.ok) return cachedManifest;  // V27.60: any non-ok → keep stale
            compressed = new Uint8Array(await res.arrayBuffer());
        }
        const parsed = JSON.parse(new TextDecoder().decode(decompress(compressed)));
        cachedManifest = {
            total_docs: parsed.total_docs,
            avg_doc_length: parsed.avg_doc_length,
            version: parsed.version || 'inverted_v1',
        };
        cachedManifestAt = Date.now();
        return cachedManifest;
    } catch (err: any) {
        console.error(`[Term Index] fetchManifest failed: ${err?.message || err}`);
        // V27.60 H3 resilience: transient err → keep serving last good manifest.
        return cachedManifest;
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
    query: string, r2Bucket: any, isDev: boolean, opTimeoutMs?: number
): Promise<{ terms: string[]; results: Map<string, TermData>; manifest: TermIndexManifest | null }> {
    const terms = tokenizeQuery(query);
    if (terms.length === 0) return { terms: [], results: new Map(), manifest: null };

    const results = new Map<string, TermData>();
    // V27.59: 2-tier read — high-freq chunked file → prefix bucket.
    // v1 individual-file legacy fallback removed (double-track scaffolding gone with V27.58 builder v1 write).
    // B8: the manifest fetch is bounded too (it precedes the term fetches and a
    // stalled R2 .get() here would block the whole tier); it already falls back
    // to the last-good stale manifest, so a timeout degrades gracefully to stale.
    const manifest = opTimeoutMs
        ? await withOpTimeout(fetchManifest(r2Bucket, isDev), opTimeoutMs, 'term:manifest').catch(() => cachedManifest)
        : await fetchManifest(r2Bucket, isDev);

    // B8: per-op firewall on EVERY term-index R2 fetch. These are pure R2 .get()s
    // (no global lock), so a stalled range read here would otherwise hang the
    // whole search route. withOpTimeout races a deadline; on timeout we treat the
    // term as un-fetched (a missed term ≠ a fabricated hit) and let the caller's
    // route budget surface a transient if nothing was resolved. The op is not
    // cancelled (op-timeout.ts) — it just no longer blocks the request.
    await Promise.all(terms.map(async (term) => {
        try {
            const fetchOne = (async () => {
                let data = await fetchHighFreqTerm(term, r2Bucket, isDev);
                if (!data) {
                    const bucket = await fetchPrefixBucket(termPrefix(term), r2Bucket, isDev);
                    if (bucket && bucket.has(term)) data = bucket.get(term) ?? null;
                }
                return data;
            })();
            const data = opTimeoutMs
                ? await withOpTimeout(fetchOne, opTimeoutMs, `term:${term}`)
                : await fetchOne;
            if (data) results.set(term, data);
        } catch (err: any) {
            console.warn(`[Term Index] term="${term}" fetch bailed: ${err?.message || err}`);
        }
    }));

    const found = [...results.keys()];
    const missed = terms.filter(t => !results.has(t));
    if (missed.length > 0) {
        console.warn(`[Term Index] query="${query}" terms=${terms.length} found=[${found.join(',')}] missed=[${missed.join(',')}]`);
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
