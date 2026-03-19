/**
 * V25.8.3 Embedding Generator — Batch ANN Vector Computation
 *
 * Computes 384D embeddings for all entities using @xenova/transformers (ONNX Runtime).
 * Model: all-MiniLM-L6-v2 (sentence-transformers)
 *
 * Design:
 * - Processes entities in configurable batches (default: 64)
 * - Generates text from name + description + body_content (truncated to 256 tokens)
 * - Injects Float32 `embedding` field into each entity object
 * - Downstream consumers (vector-core-generator.js, shard-packer-v4.js) handle Int8 quantization
 *
 * Cost: $0 (ONNX local inference in GHA, no external API)
 * Determinism: Same input → same output (ONNX is deterministic)
 *
 * Usage:
 *   import { computeEmbeddings } from './lib/embedding-generator.js';
 *   await computeEmbeddings(metadataBatch);
 *
 * Environment:
 *   EMBEDDING_BATCH_SIZE — batch size (default: 64)
 *   EMBEDDING_MODEL — model name (default: Xenova/all-MiniLM-L6-v2)
 *   EMBEDDING_SKIP — set to 'true' to skip embedding computation
 */

const BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || '64');
const MODEL_NAME = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const VECTOR_DIM = 384;
const MAX_TEXT_LENGTH = 512; // Characters to truncate input text

let _pipeline = null;

/**
 * Lazy-initialize the feature-extraction pipeline.
 * Model is downloaded once and cached by @xenova/transformers.
 */
async function getPipeline() {
    if (_pipeline) return _pipeline;
    console.log(`[EMBEDDING] Loading model: ${MODEL_NAME}...`);
    const { pipeline } = await import('@xenova/transformers');
    _pipeline = await pipeline('feature-extraction', MODEL_NAME, {
        quantized: true, // Use quantized ONNX model for speed
    });
    console.log(`[EMBEDDING] ✅ Model loaded. Dimension: ${VECTOR_DIM}`);
    return _pipeline;
}

/**
 * Build a search-optimized text representation of an entity.
 * Concatenates name + type + description + body excerpt.
 */
function buildEntityText(entity) {
    const parts = [];

    const name = entity.name || entity.displayName || entity.title || '';
    if (name) parts.push(name);

    const type = entity.type || entity.entity_type || '';
    if (type) parts.push(type);

    const author = Array.isArray(entity.author) ? entity.author.join(', ') : (entity.author || '');
    if (author) parts.push(author);

    const desc = entity.description || entity.summary || entity.seo_summary?.description || '';
    if (desc) parts.push(desc);

    const task = entity.pipeline_tag || entity.task || entity.category || '';
    if (task) parts.push(task);

    // Add body content excerpt for richer semantic signal
    const body = entity.body_content || entity.readme || '';
    if (body) {
        // Strip HTML/markdown, take first 200 chars
        const cleaned = body
            .replace(/<[^>]+>/g, ' ')
            .replace(/[#*`\[\]]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
        if (cleaned.length > 20) parts.push(cleaned);
    }

    const text = parts.join(' ').slice(0, MAX_TEXT_LENGTH);
    return text || 'unknown entity';
}

/**
 * Compute embeddings for a batch of entities.
 * Injects `embedding` (Float32 array of length 384) into each entity.
 *
 * @param {Array} entities - Entity array (mutated in-place)
 * @param {Object} options
 * @param {boolean} options.skipExisting - Skip entities that already have embeddings (default: true)
 */
export async function computeEmbeddings(entities, options = {}) {
    const { skipExisting = true } = options;

    if (process.env.EMBEDDING_SKIP === 'true') {
        console.log('[EMBEDDING] ⏭️ Skipping (EMBEDDING_SKIP=true)');
        return { computed: 0, skipped: entities.length, total: entities.length };
    }

    if (!entities || entities.length === 0) {
        console.warn('[EMBEDDING] No entities to process.');
        return { computed: 0, skipped: 0, total: 0 };
    }

    const extractor = await getPipeline();
    const startTime = Date.now();

    let computed = 0, skipped = 0;

    for (let i = 0; i < entities.length; i += BATCH_SIZE) {
        const batch = entities.slice(i, Math.min(i + BATCH_SIZE, entities.length));
        const textsToProcess = [];
        const indices = [];

        for (let j = 0; j < batch.length; j++) {
            const entity = batch[j];
            // Skip entities that already have valid embeddings
            if (skipExisting && entity.embedding && Array.isArray(entity.embedding) && entity.embedding.length === VECTOR_DIM) {
                skipped++;
                continue;
            }
            textsToProcess.push(buildEntityText(entity));
            indices.push(i + j);
        }

        if (textsToProcess.length === 0) continue;

        try {
            // Run batch inference
            const output = await extractor(textsToProcess, {
                pooling: 'mean',
                normalize: true,
            });

            // Extract embeddings and inject into entities
            const batchResults = [];
            for (let k = 0; k < indices.length; k++) {
                const entityIdx = indices[k];
                // output.tolist() returns nested arrays: [[dim0, dim1, ...], ...]
                const vec = output[k].tolist ? output[k].tolist() : Array.from(output[k].data || output[k]);
                entities[entityIdx].embedding = vec;
                computed++;
                batchResults.push({ id: entities[entityIdx].id || entities[entityIdx].slug, embedding: vec });
            }

            // Incremental Checkpoint: Notify caller to persist this batch
            if (options.onBatchComplete && typeof options.onBatchComplete === 'function') {
                try {
                    await options.onBatchComplete(batchResults);
                } catch (ce) {
                    console.warn(`[EMBEDDING] Checkpoint callback failed: ${ce.message}`);
                }
            }
        } catch (err) {
            console.error(`[EMBEDDING] Batch ${Math.floor(i / BATCH_SIZE)} failed: ${err.message}`);
            // Mark failed entities with zero vectors so pipeline doesn't break
            for (const idx of indices) {
                if (!entities[idx].embedding) {
                    entities[idx].embedding = new Array(VECTOR_DIM).fill(0);
                }
            }
        }

        // Progress logging
        const processed = Math.min(i + BATCH_SIZE, entities.length);
        if (processed % (BATCH_SIZE * 50) === 0 || processed === entities.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            const rate = (computed / (elapsed || 1)).toFixed(0);
            console.log(`[EMBEDDING] Progress: ${processed}/${entities.length} | Computed: ${computed} | Skipped: ${skipped} | ${rate} vec/s | ${elapsed}s`);
        }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[EMBEDDING] ✅ Complete: ${computed} computed, ${skipped} skipped, ${totalTime}s total (${(computed / (totalTime || 1)).toFixed(0)} vec/s)`);

    return { computed, skipped, total: entities.length };
}

/**
 * Get the vector dimension used by this generator.
 */
export function getEmbeddingDimension() {
    return VECTOR_DIM;
}
