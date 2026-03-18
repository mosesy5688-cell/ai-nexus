// src/lib/semantic-engine.ts
// V22.10 Tier 3: Semantic Engine
// Fast In-Memory Int8 Quantized Cosine Similarity Search via Cloudflare Workers AI

const VECTOR_DIMENSIONS = 384;
const HEADER_SIZE = 16;
const RECORD_SIZE = VECTOR_DIMENSIONS; // 1 byte per dimension (Int8)

// In-Memory L0 Cache Strategy: Retain the vector core in isolate RAM
// Size: ~11.5 MB, easily fits within 128MB worker limit
let VECTOR_CORE_BUFFER: Uint8Array | null = null;
let VECTOR_COUNT = 0;

/**
 * Downloads and caches the Int8 vector core from R2.
 */
export async function loadVectorCore(env: any): Promise<boolean> {
    if (VECTOR_CORE_BUFFER) return true; // Already loaded in this Isolate

    try {
        const start = Date.now();
        console.log('[Semantic Engine] Downloading vector-core.bin...');
        const isSimulating = !!env?.SIMULATE_PRODUCTION || (!!import.meta.env?.DEV && env?.NODE_ENV !== 'production');

        let arrayBuffer: ArrayBuffer;

        if (env.R2_FILES && !isSimulating) {
            const obj = await env.R2_FILES.get('data/vector-core.bin');
            if (!obj) {
                console.error('[Semantic Engine] Failed to find vector-core.bin in R2');
                return false;
            }
            arrayBuffer = await obj.arrayBuffer();
        } else {
            // Local Simulation CDN
            const res = await fetch('https://cdn.free2aitools.com/data/vector-core.bin');
            if (!res.ok) {
                console.error('[Semantic Engine] Failed to fetch vector-core.bin from CDN');
                return false;
            }
            arrayBuffer = await res.arrayBuffer();
        }

        VECTOR_CORE_BUFFER = new Uint8Array(arrayBuffer);

        // Parse Header (Offset 6: Uint32 count)
        const dv = new DataView(arrayBuffer);
        VECTOR_COUNT = dv.getUint32(6, true);

        console.log(`[Semantic Engine] Loaded ${VECTOR_COUNT} vectors in ${Date.now() - start}ms`);
        return true;
    } catch (e) {
        console.error('[Semantic Engine] Error loading vector core:', e);
        return false;
    }
}

/**
 * Embeds the user query via Cloudflare Workers AI using the BAAI BGE model.
 */
export async function embedQuery(query: string, env: any): Promise<number[] | null> {
    try {
        const start = Date.now();
        // Uses the same model standard we ingest against (e.g., bge-small-en-v1.5 or minilm)
        // Ensure that ai binding "AI" exists in wrangler.toml
        const response = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [query] });

        const embedding = response.data[0];
        console.log(`[Semantic Engine] Generated 384D float embedding via AI in ${Date.now() - start}ms`);
        return embedding;
    } catch (e) {
        console.error('[Semantic Engine] Cloudflare AI Embedding Error:', e);
        return null;
    }
}

/**
 * Performs Cosine Similarity against the loaded Int8 vector core.
 * @returns Array of sorted matching rowids and their scores.
 */
export async function searchSemantic(query: string, limit: number, env: any): Promise<{ rowid: number, score: number }[]> {
    if (!await loadVectorCore(env)) return [];

    const queryEmbedding = await embedQuery(query, env);
    if (!queryEmbedding || queryEmbedding.length !== VECTOR_DIMENSIONS) return [];

    const start = Date.now();

    // Normalize query vector for cosine similarity optimization
    let queryMag = 0;
    for (let d = 0; d < VECTOR_DIMENSIONS; d++) {
        queryMag += queryEmbedding[d] * queryEmbedding[d];
    }
    queryMag = Math.sqrt(queryMag);

    const scores = new Float32Array(VECTOR_COUNT);
    const dv = new DataView(VECTOR_CORE_BUFFER!.buffer);

    // High performance sequential scan over Int8 array
    for (let i = 0; i < VECTOR_COUNT; i++) {
        const offset = HEADER_SIZE + (i * RECORD_SIZE);
        let dotProduct = 0;
        let dbMag = 0;

        for (let d = 0; d < VECTOR_DIMENSIONS; d++) {
            // Int8 range [-128, 127]
            const dbVal = dv.getInt8(offset + d);
            dotProduct += queryEmbedding[d] * dbVal;
            dbMag += dbVal * dbVal;
        }

        if (dbMag === 0) {
            scores[i] = -1; // Ignore zero vectors
        } else {
            scores[i] = dotProduct / (queryMag * Math.sqrt(dbMag));
        }
    }

    // Sort Indices based on highest scores
    // Create an array mapping [0..VECTOR_COUNT-1]
    const indices = new Int32Array(VECTOR_COUNT);
    for (let i = 0; i < VECTOR_COUNT; i++) indices[i] = i;

    // Fast partial sort (top K) using standard sort (engines handle small limits quite fast)
    const sortedIndices = Array.from(indices)
        .filter(idx => scores[idx] > -1) // Remove zero/bad vectors
        .sort((a, b) => scores[b] - scores[a])
        .slice(0, limit);

    console.log(`[Semantic Engine] Cosine Similarity Scan took ${Date.now() - start}ms`);

    // The index corresponds to rowid = index + 1 in SQLite meta.db
    return sortedIndices.map(index => ({
        rowid: index + 1,
        score: scores[index]
    }));
}
