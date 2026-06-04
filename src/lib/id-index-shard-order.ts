/**
 * Read-path P1: shared shard-ordering helper for the id-index warm tier.
 *
 * Returns the existing shardForms entries REORDERED so that, when the in-memory
 * id-index resolves a candidate to its canonical write shard, that shard is
 * probed first. It only reorders — never drops, adds, or rewrites an entry — so
 * a stale, collided, or absent index can never change which entities are
 * reachable (zero regression). Best-effort: any load/lookup failure (including
 * id-index.bin not yet baked) returns the original insertion order.
 *
 * Used by both the entity API route and the page metadata provider so the
 * fast-path logic stays single-sourced.
 */
import { loadIdIndex, lookup as idIndexLookup } from './id-index-reader.js';

export async function orderShardsByIndex(
    shardForms: Map<number, string[]>,
    candidates: string[],
    env: any,
): Promise<[number, string[]][]> {
    const entries = [...shardForms.entries()];
    try {
        if (!(await loadIdIndex(env))) return entries;
        for (const c of candidates) {
            const hit = idIndexLookup(c);
            if (hit && shardForms.has(hit.shardIdx)) {
                const first = entries.filter(([s]) => s === hit.shardIdx);
                const rest = entries.filter(([s]) => s !== hit.shardIdx);
                return [...first, ...rest];
            }
        }
    } catch {
        /* fall through to original order — never block the probe */
    }
    return entries;
}
