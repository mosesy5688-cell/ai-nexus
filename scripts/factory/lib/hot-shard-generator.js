import fsSync from 'fs';
import path from 'path';

const HOT_SHARD_PATH = './output/data/hot-shard.bin';
const HOT_SHARD_LIMIT = 50000;
const TYPE_ENUM = { model: 0, dataset: 1, agent: 2, tool: 3, space: 4, paper: 5, prompt: 6 };

/**
 * V22.9 Hot Shard Generator — Zero-Copy Binary Format
 */
export function generateHotShard(sortedEntities) {
    const count = Math.min(sortedEntities.length, HOT_SHARD_LIMIT);
    if (count === 0) { console.warn('[HotShard] ⚠️ No entities to pack.'); return; }

    console.log(`[HotShard] 🔥 Packing Top ${count} entities into Zero-Copy Binary...`);

    const HEADER_SIZE = 16;
    const RECORD_SIZE = 32;
    const recordsSize = count * RECORD_SIZE;

    const encoder = new TextEncoder();
    const stringBuffers = [];
    let poolSize = 0;
    const entries = [];

    for (let i = 0; i < count; i++) {
        const e = sortedEntities[i];
        const nameStr = String(e.name || e.displayName || '');
        const slugStr = String(e.slug || e.id || '');
        const nameBuf = encoder.encode(nameStr);
        const slugBuf = encoder.encode(slugStr);

        entries.push({
            nameBuf, slugBuf,
            namePoolOffset: poolSize,
            slugPoolOffset: poolSize + nameBuf.byteLength,
            fniScore: e.fni_score ?? e.fni?.score ?? 0,
            downloads: e.downloads ?? 0,
            stars: e.stars ?? e.likes ?? 0,
            paramsBil: e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0,
            entityType: TYPE_ENUM[e.type || e.entity_type] ?? 0,
            isTrending: e.is_trending ? 1 : 0,
        });

        stringBuffers.push(nameBuf, slugBuf);
        poolSize += nameBuf.byteLength + slugBuf.byteLength;
    }

    const totalSize = HEADER_SIZE + recordsSize + poolSize;
    const buf = Buffer.alloc(totalSize);
    const strPoolOffset = HEADER_SIZE + recordsSize;

    buf.write('HOTS', 0, 4, 'ascii');
    buf.writeUInt16LE(1, 4);
    buf.writeUInt32LE(count, 6);
    buf.writeUInt32LE(strPoolOffset, 10);

    for (let i = 0; i < entries.length; i++) {
        const off = HEADER_SIZE + i * RECORD_SIZE;
        const rec = entries[i];
        buf.writeUInt32LE(rec.namePoolOffset, off + 0);
        buf.writeUInt16LE(rec.nameBuf.byteLength, off + 4);
        buf.writeUInt32LE(rec.slugPoolOffset, off + 6);
        buf.writeUInt16LE(rec.slugBuf.byteLength, off + 10);
        buf.writeFloatLE(rec.fniScore, off + 12);
        buf.writeUInt32LE(Math.min(rec.downloads, 0xFFFFFFFF), off + 16);
        buf.writeUInt32LE(Math.min(rec.stars, 0xFFFFFFFF), off + 20);
        buf.writeFloatLE(rec.paramsBil, off + 24);
        buf.writeUInt8(rec.entityType, off + 28);
        buf.writeUInt8(rec.isTrending, off + 29);
    }

    let poolPos = strPoolOffset;
    for (const sb of stringBuffers) {
        sb.forEach((byte, j) => { buf[poolPos + j] = byte; });
        poolPos += sb.byteLength;
    }

    fsSync.mkdirSync(path.dirname(HOT_SHARD_PATH), { recursive: true });
    fsSync.writeFileSync(HOT_SHARD_PATH, buf);
    console.log(`[HotShard] ✅ Generated ${HOT_SHARD_PATH} (${count} entities, ${(totalSize / 1024).toFixed(1)} KB)`);
}
