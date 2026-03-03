import fsSync from 'fs';
import path from 'path';

const HOT_SHARD_PATH = './output/data/hot-shard.bin';
const HOT_SHARD_LIMIT = 30000; // V22.9: The Architectural Sweet Spot (30k limit enables rich metadata)
const TYPE_ENUM = { model: 0, dataset: 1, agent: 2, tool: 3, space: 4, paper: 5, prompt: 6 };

/**
 * V22.9 Hot Shard Generator — Zero-Copy Binary Format
 */
export function generateHotShard(sortedEntities) {
    const count = Math.min(sortedEntities.length, HOT_SHARD_LIMIT);
    if (count === 0) { console.warn('[HotShard] ⚠️ No entities to pack.'); return; }

    console.log(`[HotShard] 🔥 Packing Top ${count} entities into Zero-Copy Binary...`);

    const HEADER_SIZE = 16;
    // V22.9 High-Density Record
    // Pointers (30): Name(6), Slug(6), Author(6), License(6), Task(6)
    // Numerics (26): Fni(4), DLs(4), Stars(4), Params(4), Context(4), Updated(4), Type(1), Trend(1)
    const RECORD_SIZE = 56;
    const recordsSize = count * RECORD_SIZE;

    const encoder = new TextEncoder();
    const stringBuffers = [];
    let poolSize = 0;
    const entries = [];

    for (let i = 0; i < count; i++) {
        const e = sortedEntities[i];
        const nameStr = String(e.name || e.displayName || '');
        const slugStr = String(e.slug || e.id || '');

        // Derive Author from explicit prop or gracefully fallback to Slug hierarchy
        let authorStr = String(e.author || e.creator || '');
        if (!authorStr && slugStr.includes('--')) {
            const parts = slugStr.split('--');
            if (parts.length >= 3) authorStr = parts[1];
        }

        // New High-Density Strings
        const licenseStr = String(e.license || e.content_license || '').substring(0, 30); // Max reasonable length
        const taskStr = String(e.pipeline_tag || e.task || e.category || '').substring(0, 30);

        const nameBuf = encoder.encode(nameStr);
        const slugBuf = encoder.encode(slugStr);
        const authBuf = encoder.encode(authorStr);
        const licBuf = encoder.encode(licenseStr);
        const taskBuf = encoder.encode(taskStr);

        // Derive Timestamps & Technicals
        let updatedSecs = 0;
        if (e.lastModified || e.updated_at || e.last_modified) {
            const date = new Date(e.lastModified || e.updated_at || e.last_modified);
            if (!isNaN(date.getTime())) updatedSecs = Math.floor(date.getTime() / 1000);
        }

        let contextLen = e.technical?.context_length ?? e.context_length ?? 0;
        if (typeof contextLen !== 'number') contextLen = parseInt(String(contextLen)) || 0;

        entries.push({
            nameBuf, slugBuf, authBuf, licBuf, taskBuf,
            namePoolOffset: poolSize,
            slugPoolOffset: poolSize + nameBuf.byteLength,
            authPoolOffset: poolSize + nameBuf.byteLength + slugBuf.byteLength,
            licPoolOffset: poolSize + nameBuf.byteLength + slugBuf.byteLength + authBuf.byteLength,
            taskPoolOffset: poolSize + nameBuf.byteLength + slugBuf.byteLength + authBuf.byteLength + licBuf.byteLength,

            fniScore: e.fni_score ?? e.fni?.score ?? 0,
            downloads: e.downloads ?? 0,
            stars: e.stars ?? e.likes ?? 0,
            paramsBil: e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0,
            contextLength: contextLen,
            updatedSecs: updatedSecs,
            entityType: TYPE_ENUM[e.type || e.entity_type] ?? 0,
            isTrending: e.is_trending ? 1 : 0,
        });

        stringBuffers.push(nameBuf, slugBuf, authBuf, licBuf, taskBuf);
        poolSize += nameBuf.byteLength + slugBuf.byteLength + authBuf.byteLength + licBuf.byteLength + taskBuf.byteLength;
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

        // --- POINTERS (30 bytes total) ---
        buf.writeUInt32LE(rec.namePoolOffset, off + 0);
        buf.writeUInt16LE(rec.nameBuf.byteLength, off + 4);
        buf.writeUInt32LE(rec.slugPoolOffset, off + 6);
        buf.writeUInt16LE(rec.slugBuf.byteLength, off + 10);
        buf.writeUInt32LE(rec.authPoolOffset, off + 12);
        buf.writeUInt16LE(rec.authBuf.byteLength, off + 16);

        // V22.9: Added License and Task Pointers
        buf.writeUInt32LE(rec.licPoolOffset, off + 18);
        buf.writeUInt16LE(rec.licBuf.byteLength, off + 22);
        buf.writeUInt32LE(rec.taskPoolOffset, off + 24);
        buf.writeUInt16LE(rec.taskBuf.byteLength, off + 28);

        // --- NUMERICS (26 bytes total) ---
        buf.writeFloatLE(rec.fniScore, off + 30);
        buf.writeUInt32LE(Math.min(rec.downloads, 0xFFFFFFFF), off + 34);
        buf.writeUInt32LE(Math.min(rec.stars, 0xFFFFFFFF), off + 38);
        buf.writeFloatLE(rec.paramsBil, off + 42);

        // V22.9: High-Density Technicals
        buf.writeUInt32LE(Math.min(rec.contextLength, 0xFFFFFFFF), off + 46);
        buf.writeUInt32LE(Math.min(rec.updatedSecs, 0xFFFFFFFF), off + 50);

        buf.writeUInt8(rec.entityType, off + 54);
        buf.writeUInt8(rec.isTrending, off + 55);
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
