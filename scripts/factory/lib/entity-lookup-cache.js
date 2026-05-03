/**
 * V25.12 Entity Lookup Cache (2026-05-04)
 *
 * Streaming-compliant lookup table for mesh relations resolution.
 * Eliminates the 172-min Pass 1 scan in pack-db.js by storing
 * { id -> { name, icon } } in embedding-cache.db, accessed lazily via SQLite.
 *
 * Streaming design:
 *   - NO in-memory Map (zero accumulator, satisfies streaming principle)
 *   - Lookup proxy queries SQLite per call (~10-20us each, prepared statement)
 *   - Insert via bounded batch (max 1000 entries, flush in transaction)
 *
 * Trade-offs:
 *   - +50s total runtime (487K x ~5 mesh refs x 20us SQLite query)
 *   - vs 100MB RAM savings + truly streaming-compliant
 *   - Bonus: previous-run entities resolve instantly (never fallback for stable refs)
 *
 * Forward reference behavior:
 *   - Same-run new entity A references new entity B (B later in stream):
 *     A falls back to default (name=targetId, icon=fallback box)
 *   - Previous-run entities: always resolve (already in SQLite from prior run)
 *   - Acceptable: less than 1% of relations are same-run cross-refs
 */

const FLUSH_SIZE = 1000;

/**
 * Build a streaming lookup access object for pack-db.js main pass.
 *
 * Returns:
 *   - lookup: proxy object with .get(id) → { name, icon } | null
 *             (compatible with distillEntity's entityLookup parameter)
 *   - trackEntity: function called per main-pass entity to enqueue insert
 *   - flush: function to flush remaining batch (call after main pass)
 *   - getStats: diagnostic { inserted, queried }
 *
 * @param {Database} cacheDb - opened embedding-cache.db
 */
export function createEntityLookupAccess(cacheDb) {
    const getStm = cacheDb.prepare('SELECT name, icon FROM entity_lookup WHERE id = ?');
    const putStm = cacheDb.prepare('INSERT OR IGNORE INTO entity_lookup (id, name, icon) VALUES (?, ?, ?)');

    let queryCount = 0;
    let insertedCount = 0;
    let batch = [];

    const flush = () => {
        if (batch.length === 0) return;
        const insertMany = cacheDb.transaction((entries) => {
            for (const e of entries) putStm.run(e.id, e.name || e.id, e.icon || '');
        });
        insertMany(batch);
        insertedCount += batch.length;
        batch = [];
    };

    const lookup = {
        get(id) {
            queryCount++;
            return getStm.get(id) || null;
        }
    };

    const trackEntity = (id, name, icon) => {
        if (!id) return;
        batch.push({ id, name, icon });
        if (batch.length >= FLUSH_SIZE) flush();
    };

    const getStats = () => ({ inserted: insertedCount, queried: queryCount });

    return { lookup, trackEntity, flush, getStats };
}

/**
 * Diagnostic helper.
 * @returns {number} Row count in entity_lookup table
 */
export function getEntityLookupSize(cacheDb) {
    return cacheDb.prepare('SELECT COUNT(*) as n FROM entity_lookup').get().n;
}

/**
 * Post-pass mesh fix-up.
 *
 * distillEntity marks forward-reference misses (target entity tracked but
 * not yet flushed) with `_unresolved: 1` in ui_related_mesh entries. After
 * the main pass commits and lookupAccess.flush() runs, entity_lookup is
 * complete — this function re-resolves every marked entry.
 *
 * Restores 100% parity with the pre-V25.12 behavior (in-memory Map pre-scan).
 * Cost: ~30s for 487K rows via prepared-statement UPDATE in a transaction.
 *
 * @param {Database} cacheDb
 * @param {Object<string, Database>} metaDbs
 * @returns {{rowsUpdated:number, refsResolved:number}}
 */
export function resolveMeshFixup(cacheDb, metaDbs) {
    const getStm = cacheDb.prepare('SELECT name, icon FROM entity_lookup WHERE id = ?');
    let rowsUpdated = 0, refsResolved = 0;
    for (const db of Object.values(metaDbs)) {
        const updateStm = db.prepare('UPDATE entities SET ui_related_mesh = ? WHERE id = ?');
        const candidates = db.prepare(
            "SELECT id, ui_related_mesh FROM entities WHERE ui_related_mesh LIKE '%_unresolved%'"
        ).all();
        if (candidates.length === 0) continue;
        const fixOne = db.transaction((rows) => {
            for (const row of rows) {
                const mesh = JSON.parse(row.ui_related_mesh);
                let changed = false;
                for (const rel of mesh) {
                    if (rel._unresolved) {
                        const t = getStm.get(rel.id);
                        if (t && t.name) { rel.name = t.name; rel.icon = t.icon || '📦'; refsResolved++; }
                        delete rel._unresolved;
                        changed = true;
                    }
                }
                if (changed) { updateStm.run(JSON.stringify(mesh), row.id); rowsUpdated++; }
            }
        });
        fixOne(candidates);
    }
    return { rowsUpdated, refsResolved };
}

/**
 * Post-pass cleanup: flush HTML cache + flush lookup batch + run embedding compute.
 * Called once after main streaming pass. Centralizes V25.12's post-pass logic.
 *
 * @param {object} ctx
 */
export async function finalizeStreamingPack(ctx) {
    const { cacheDb, lookupAccess, uncachedEntities, computeEmbeddings, saveBatch, flushDistillerCache, getDistillerStats } = ctx;

    flushDistillerCache();
    lookupAccess.flush();

    const lookupStats = lookupAccess.getStats();
    if (lookupStats.inserted > 0) {
        console.log(`[VFS] entity_lookup: ${lookupStats.inserted} new entries persisted, ${lookupStats.queried} mesh queries.`);
    }

    const dStats = getDistillerStats();
    if (dStats.total > 0) {
        const hitRate = (dStats.hits / dStats.total * 100).toFixed(1);
        console.log(`[VFS] HTML cache: ${dStats.hits} hits / ${dStats.total} total (${hitRate}% hit rate, ${dStats.errors} errors)`);
    }

    if (uncachedEntities.length === 0) {
        console.log(`[VFS] No new entities — embedding compute skipped.`);
        return;
    }

    console.log(`[VFS] Computing embeddings for ${uncachedEntities.length} uncached entities...`);
    for (let i = 0; i < uncachedEntities.length; i += 500) {
        const batch = uncachedEntities.slice(i, i + 500);
        await computeEmbeddings(batch, { onBatchComplete: async (results) => saveBatch(cacheDb, results) });
        if ((i + 500) % 5000 < 500) console.log(`[VFS] Embeddings: ${Math.min(i + 500, uncachedEntities.length)}/${uncachedEntities.length}...`);
    }
    console.log(`[VFS] Embedding pass complete: ${uncachedEntities.length} newly computed.`);
}
