// V27.0 Embedding Shard Cache — 1000 vectors/shard, natural sharding (P3)
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { zstdCompress, zstdDecompress } from './zstd-helper.js';

const VEC_DIM = 768;

export function writeEmbeddingShard(shardDir, shardIdx, entries) {
    fs.mkdirSync(shardDir, { recursive: true });
    const count = entries.length;
    const parts = [Buffer.alloc(4)];
    parts[0].writeUInt32LE(count);
    for (const { id, vector } of entries) {
        const idBuf = Buffer.from(id, 'utf-8');
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16LE(idBuf.length);
        parts.push(lenBuf, idBuf);
        const vecBuf = Buffer.isBuffer(vector) ? vector : Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        parts.push(vecBuf);
    }
    const raw = Buffer.concat(parts);
    const compressed = zstdCompress(raw);
    const name = `embed-${String(shardIdx).padStart(3, '0')}.bin.zst`;
    const tmpPath = path.join(shardDir, name + '.tmp');
    fs.writeFileSync(tmpPath, compressed);
    fs.renameSync(tmpPath, path.join(shardDir, name));
    return { path: name, rawSize: raw.length, compressedSize: compressed.length };
}

export function readEmbeddingShard(shardDir, shardIdx) {
    const name = `embed-${String(shardIdx).padStart(3, '0')}.bin.zst`;
    const filePath = path.join(shardDir, name);
    if (!fs.existsSync(filePath)) return null;
    const compressed = fs.readFileSync(filePath);
    const raw = zstdDecompress(compressed);
    return parseShardBuffer(raw);
}

function parseShardBuffer(buf) {
    const count = buf.readUInt32LE(0);
    let offset = 4;
    const entries = new Map();
    for (let i = 0; i < count; i++) {
        const idLen = buf.readUInt16LE(offset); offset += 2;
        const id = buf.toString('utf-8', offset, offset + idLen); offset += idLen;
        const vector = new Int8Array(buf.buffer, buf.byteOffset + offset, VEC_DIM); offset += VEC_DIM;
        entries.set(id, Buffer.from(vector));
    }
    return entries;
}

export async function scanAllShardIds(shardDir) {
    const idToShard = new Map();
    const files = await fsp.readdir(shardDir).catch(() => []);
    const shardFiles = files.filter(f => f.startsWith('embed-') && f.endsWith('.bin.zst')).sort();
    for (const f of shardFiles) {
        const idx = parseInt(f.match(/embed-(\d+)/)?.[1] || '-1');
        if (idx < 0) continue;
        const compressed = await fsp.readFile(path.join(shardDir, f));
        const raw = zstdDecompress(compressed);
        const count = raw.readUInt32LE(0);
        let offset = 4;
        for (let i = 0; i < count; i++) {
            const idLen = raw.readUInt16LE(offset); offset += 2;
            const id = raw.toString('utf-8', offset, offset + idLen); offset += idLen;
            idToShard.set(id, idx);
            offset += VEC_DIM;
        }
    }
    return idToShard;
}

export function getVector(shardDir, shardIdx, entityId) {
    const shard = readEmbeddingShard(shardDir, shardIdx);
    if (!shard) return null;
    const vec = shard.get(entityId);
    return vec ? new Int8Array(vec.buffer, vec.byteOffset, vec.byteLength) : null;
}

export function* iterateAllVectors(shardDir) {
    const files = fs.readdirSync(shardDir).filter(f => f.startsWith('embed-') && f.endsWith('.bin.zst')).sort();
    for (const f of files) {
        const compressed = fs.readFileSync(path.join(shardDir, f));
        const raw = zstdDecompress(compressed);
        const count = raw.readUInt32LE(0);
        let offset = 4;
        for (let i = 0; i < count; i++) {
            const idLen = raw.readUInt16LE(offset); offset += 2;
            const id = raw.toString('utf-8', offset, offset + idLen); offset += idLen;
            const vector = new Int8Array(raw.buffer, raw.byteOffset + offset, VEC_DIM); offset += VEC_DIM;
            yield { id, vector };
        }
    }
}
