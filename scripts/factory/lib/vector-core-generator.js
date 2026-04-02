import fsSync from 'fs';
import path from 'path';

const VECTOR_CORE_PATH = './output/data/vector-core.bin';
const HOT_SHARD_LIMIT = 30000;
// V2.0: 768-dimensional embedding for bge-base-en-v1.5 semantic search
const VECTOR_DIMENSIONS = 768;

/**
 * V22.10 Semantic Engine (Tier 3) — Vector Core Generator
 * Quantizes high-dimensional Float32 embeddings into Int8 flat arrays.
 * Zero-copy aligned layout for direct SSR access constraints.
 */
export function generateVectorCore(sortedEntities) {
    const count = Math.min(sortedEntities.length, HOT_SHARD_LIMIT);
    if (count === 0) { console.warn('[VectorCore] ⚠️ No entities to pack.'); return; }

    console.log(`[VectorCore] 📐 Packing Top ${count} entities into Int8 Quantized Binary...`);

    // 16-byte Header
    // Magic: "VECT" (4) | Version: UInt16 (2) | Count: UInt32 (4) | Dimensions: UInt32 (4) | Reserved: (2)
    const HEADER_SIZE = 16;

    // Each record contains its entity ID/Slug hash or offset (4 bytes) + the Int8 Array holding dimensions
    // We'll use the Hot Shard strict structural assumption: 
    // The i-th vector in vector-core corresponds to the i-th entity in hot-shard.
    const RECORD_SIZE = VECTOR_DIMENSIONS;
    const totalSize = HEADER_SIZE + (count * RECORD_SIZE);

    const buf = Buffer.alloc(totalSize);

    // Write Header
    buf.write('VECT', 0, 4, 'ascii');
    buf.writeUInt16LE(1, 4); // v1
    buf.writeUInt32LE(count, 6);
    buf.writeUInt32LE(VECTOR_DIMENSIONS, 10);

    let vectorsPopulated = 0;

    for (let i = 0; i < count; i++) {
        const e = sortedEntities[i];
        const offset = HEADER_SIZE + (i * RECORD_SIZE);

        let vec = e.embeddings || e.embedding;
        if (vec && Array.isArray(vec) && vec.length === VECTOR_DIMENSIONS) {
            vectorsPopulated++;
            // Quantize and write vector
            for (let d = 0; d < VECTOR_DIMENSIONS; d++) {
                // Assuming standard embedding where values are typically between -1.0 and 1.0. 
                // We quantize float32 into signed Int8 (-128 to 127).
                // Int8 = clamp(round(val * 127), -128, 127)
                let val = Math.round(vec[d] * 127);
                if (val > 127) val = 127;
                if (val < -128) val = -128;
                // Int8 requires two's complement unsigned representation for Buffer.writeUInt8 
                // Wait, Buffer has writeInt8!
                buf.writeInt8(val, offset + d);
            }
        } else {
            // Null or missing embeddings -> Write Zero Vectors
            for (let d = 0; d < VECTOR_DIMENSIONS; d++) {
                buf.writeInt8(0, offset + d);
            }
        }
    }

    fsSync.mkdirSync(path.dirname(VECTOR_CORE_PATH), { recursive: true });
    fsSync.writeFileSync(VECTOR_CORE_PATH, buf);
    console.log(`[VectorCore] ✅ Generated ${VECTOR_CORE_PATH} (${count} items, ${VECTOR_DIMENSIONS}D). Populated: ${vectorsPopulated}/${count}. Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
}
