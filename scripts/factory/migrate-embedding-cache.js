#!/usr/bin/env node
// One-time migration: embedding-cache.db (SQLite) → per-shard embed-NNN.bin.zst
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { writeEmbeddingShard } from './lib/embedding-shard-cache.js';

const SQLITE_PATH = process.argv[2] || './output/cache/embedding-cache.db';
const SHARD_DIR = process.argv[3] || './output/cache/embeddings';
const SHARD_SIZE = 1000;

if (!fs.existsSync(SQLITE_PATH)) {
    console.log(`[MIGRATE] No SQLite cache at ${SQLITE_PATH} — nothing to migrate.`);
    process.exit(0);
}

const existing = fs.readdirSync(SHARD_DIR).filter(f => f.startsWith('embed-') && f.endsWith('.bin.zst'));
if (existing.length > 0) {
    console.log(`[MIGRATE] ${existing.length} shards already exist — skipping migration.`);
    process.exit(0);
}

console.log(`[MIGRATE] Reading embeddings from ${SQLITE_PATH}...`);
const db = new Database(SQLITE_PATH, { readonly: true });
const rows = db.prepare('SELECT id, vector FROM embeddings').all();
db.close();
console.log(`[MIGRATE] Found ${rows.length} embeddings. Writing to ${SHARD_DIR}...`);

fs.mkdirSync(SHARD_DIR, { recursive: true });
let shardIdx = 0, batch = [];
for (const row of rows) {
    batch.push({ id: row.id, vector: Buffer.from(row.vector) });
    if (batch.length >= SHARD_SIZE) {
        writeEmbeddingShard(SHARD_DIR, shardIdx, batch);
        shardIdx++;
        batch = [];
    }
}
if (batch.length > 0) { writeEmbeddingShard(SHARD_DIR, shardIdx, batch); shardIdx++; }
console.log(`[MIGRATE] ✅ Wrote ${shardIdx} shards (${rows.length} vectors) to ${SHARD_DIR}`);
