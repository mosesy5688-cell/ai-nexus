import Database from 'better-sqlite3';
import fsSync from 'fs';
import path from 'path';

/**
 * V25.8.3 Embedding Cache Vault
 * Persistence for 768D ANN vectors via Int8-quantized SQLite BLOBs.
 */

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        vector BLOB
    );
    -- V25.12 (2026-05-04): pack-db.js 6h timeout fix
    CREATE TABLE IF NOT EXISTS entity_lookup (
        id TEXT PRIMARY KEY,
        name TEXT,
        icon TEXT
    );
    CREATE TABLE IF NOT EXISTS html_cache (
        hash TEXT PRIMARY KEY,
        html TEXT
    );
`;

/**
 * Open or create the embedding cache.
 */
export function openCache(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(SCHEMA);
    return db;
}

/**
 * Validate that the cache model matches the current engine model.
 */
export function validateModel(db, expectedModel) {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('model_name');
    if (!row) {
        db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('model_name', expectedModel);
        return true;
    }
    if (row.value !== expectedModel) {
        console.warn(`[CACHE] ⚠️ Model mismatch: Found ${row.value}, expected ${expectedModel}. Wiping cache...`);
        db.exec('DELETE FROM embeddings');
        db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(expectedModel, 'model_name');
        return false;
    }
    return true;
}

/**
 * Load all cached IDs into a Set for memory-efficient existence checking.
 * Returns Set<id> — consumes ~30MB for 413k entities.
 */
export function loadIds(db) {
    console.log('[CACHE] 🔍 Scanning ID records in vault...');
    const rows = db.prepare('SELECT id FROM embeddings').all();
    const idSet = new Set();
    for (const row of rows) idSet.add(row.id);
    console.log(`[CACHE] ✅ Found ${idSet.size} cached vectors.`);
    return idSet;
}

/**
 * Load all cached embeddings into a Map for O(1) memory access.
 * Returns Map<id, Float32Array(768)>
 */
export function loadAll(db) {
    console.log('[CACHE] 📥 Loading embeddings into memory...');
    const rows = db.prepare('SELECT id, vector FROM embeddings').all();
    const cache = new Map();
    
    for (const row of rows) {
        // De-quantize Int8 -> Float32
        const int8 = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
        const float32 = new Float32Array(int8.length);
        for (let i = 0; i < int8.length; i++) {
            float32[i] = int8[i] / 127.0;
        }
        cache.set(row.id, float32);
    }
    
    console.log(`[CACHE] ✅ Loaded ${cache.size} vectors from storage.`);
    return cache;
}

/**
 * Save a batch of embeddings.
 * @param {Database} db 
 * @param {Array<{id: string, embedding: number[]}>} batch 
 */
export function saveBatch(db, batch) {
    const stm = db.prepare('INSERT OR REPLACE INTO embeddings (id, vector) VALUES (?, ?)');
    db.transaction((items) => {
        for (const item of items) {
            const vec = item.embedding;
            // Quantize Float32 -> Int8
            const int8 = new Int8Array(vec.length);
            for (let i = 0; i < vec.length; i++) {
                int8[i] = Math.max(-128, Math.min(127, Math.round(vec[i] * 127)));
            }
            stm.run(item.id, Buffer.from(int8.buffer));
        }
    })(batch);
}

export function closeCache(db) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
}
