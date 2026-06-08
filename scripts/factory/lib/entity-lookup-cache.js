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

import { humanizeId } from './derive-slug.js';

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
            // Mesh degenerate-name fix: a name-less entity must NOT be stored with
            // name === id (a degenerate echo). resolveMeshEdge keeps its edge (it
            // resolves to a real packed entity), but isResolvedMeshNode (the bake
            // canary, mesh-resolve-filter.js:75) correctly rejects name === id.
            // The caller (pack-db.js:114) already coalesces a missing name to the
            // id, so we re-detect that echo here and derive an HONEST humanized
            // display name from the entity's own real id/slug instead.
            for (const e of entries) {
                const name = (e.name && e.name !== e.id) ? e.name : humanizeId(e.id);
                putStm.run(e.id, name, e.icon || '');
            }
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

    // V27.94 (3rd-diag): #2114 added a normalizeId(e.id) extra-key insert here
    // believing the SOURCE (entity) id diverged from the lookup key. That was a
    // PROVEN NO-OP: e.id is ALREADY canonical, so normalizeId(e.id) === e.id and
    // the extra insert was a dup. The real divergence is on the TARGET side —
    // the distiller read STRIPPED relation targets and looked them up against
    // canonical keys (100% miss). Fixed in v25-distiller.js by canonicalizing
    // the target before .get(). Reverted to the simple insert here.
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
 * V27.94 (3rd-diag): the distiller now canonicalizes every relation target
 * before lookup and writes a humanized display name on a miss WITHOUT an
 * `_unresolved` marker (the name is final; never-streamed knowledge/hub targets
 * would never resolve and the canary counts `_unresolved` itself as degenerate).
 * So this function normally finds zero candidates and is a no-op. It is kept as
 * a defensive net: if any `_unresolved` markers ever reappear, it re-resolves
 * them honestly — clearing the marker ONLY on a real hit (never unconditionally,
 * which previously masked 100% of misses behind "0 refs re-resolved").
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
                        // V27.94 (3rd-diag): rel.id is already the CANONICAL id
                        // the distiller wrote (entity_lookup's key namespace), so
                        // a forward-ref entity now flushed resolves here. HONESTY
                        // FIX: only clear _unresolved on a real resolve — never
                        // unconditionally delete it (that masked 100% of misses,
                        // hiding "0 refs re-resolved" behind 0 surviving markers).
                        const t = getStm.get(rel.id);
                        if (t && t.name) {
                            rel.name = t.name; rel.icon = t.icon || '📦';
                            delete rel._unresolved; refsResolved++; changed = true;
                        }
                        // genuine miss: leave _unresolved + the humanized name the
                        // distiller already supplied (name !== id, non-degenerate).
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
