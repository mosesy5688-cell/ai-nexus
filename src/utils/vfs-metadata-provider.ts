import { normalizeEntitySlug } from './entity-cache-reader-core.js';
import { getCachedDbConnection, loadManifest, executeSql } from '../lib/sqlite-engine.js';
import { xxhash64Mod } from './xxhash64.js';
import { generatePaperCandidates } from '../lib/slug-helper.js';
import { withOpTimeout, isOpTimeout } from '../lib/op-timeout.js';
import { resolveShardsForCandidates } from '../lib/entity-absence-oracle.js';
import { resolveEntityMatch, CANDIDATE_FETCH_LIMIT } from '../lib/entity-match-resolver.js';
import { env } from 'cloudflare:workers';

// V27.91: wall-clock budget for the multi-shard probing below. A miss
// (genuinely-dead URL, e.g. /paper/<arxivid> not in corpus) must not run the
// full cold R2-VFS open sequence into CF's ~30s limit and 524 Googlebot. Real
// entities hit an early probe and return before exhausting the budget, so this
// cannot regress them.
const FALLBACK_BUDGET_MS = 6000;

// V27.97: per-op timeout firewall. The budget above bounds the LOOP (between
// probes); this bounds a SINGLE cold op that hangs (e.g. a stalled R2 range
// read inside one open/SQL). Must stay <= FALLBACK_BUDGET_MS so a single slow
// op cannot push past the total budget, and worst-case (per-op x probes, itself
// gated by the total budget) stays well under CF's ~25s. On timeout the op is
// NOT cancelled (see op-timeout.ts header) — it finishes in the background,
// releases its own SQLite lock, and warms the cache for the retry.
const OP_TIMEOUT_MS = 5000;

// C4 Stage 1 (corrected): bounded MULTI-row fetch of CANDIDATE_FETCH_LIMIT (26 =
// public cap + 1) rows so the resolver can DETECT overflow instead of truncating
// into a false unique. A slug can be shared by two typed records co-resident on
// one shard; the human route returns ONLY a row of the requested route type. The
// ORDER BY binds the queried form as id + umid so an exact-id/umid row, if it
// exists, is always in the window; type-ASC,id-ASC keeps the window deterministic.
const SELECT_SQL = `SELECT * FROM entities WHERE slug = ? OR id = ? OR umid = ? ORDER BY (id = ?) DESC, (umid = ?) DESC, type ASC, id ASC LIMIT ${CANDIDATE_FETCH_LIMIT}`;

/**
 * Type-enforced pick for a human /<type>/ route. Discriminated outcome:
 *   - { row }      resolver selected a row of the requested route type -> render.
 *   - { overflow } the candidate set overflowed the public cap and NO authoritative
 *                  route-typed exact row resolved -> INCONCLUSIVE: the caller returns
 *                  a retryable transient, NEVER a wrong-typed row / clean notFound /
 *                  false unique from a truncated window.
 *   - null         clean non-match (wrong-type-only, plain ambiguity, conflict, miss)
 *                  -> keep probing / fall through to an honest notFound.
 * A /model/ page never renders a dataset twin (and vice versa).
 */
type RoutePick = { row: any } | { overflow: true } | null;
function pickRouteTyped(rows: any[], form: string, type: string): RoutePick {
    const m = resolveEntityMatch(form, type, rows);
    if (m.kind === 'FOUND') return { row: m.row };
    if (m.kind === 'AMBIGUOUS' && (m as any).candidate_overflow) return { overflow: true };
    return null;
}

/**
 * V27.97: 3-way discriminated result. The old contract (`{data,source}` | null)
 * conflated a genuine miss with a transient error/timeout, so a flaky lookup of
 * a REAL entity could be cached as a false 404 (SEO harm). Callers MUST branch:
 *   - found     -> { data, source }          render normally (cache OK)
 *   - notFound  -> { notFound: true }         confirmed-dead URL -> 404 + brief edge cache
 *   - transient -> { transient: true }        timeout/error/budget-bail -> 503/soft + NO cache, retryable
 */
export type VfsMetadataResult =
    | { data: any; source: string }
    | { notFound: true }
    | { transient: true };

export function isVfsFound(r: VfsMetadataResult): r is { data: any; source: string } {
    return 'data' in r;
}

export async function resolveVfsMetadata(type: string, slug: string, locals: any = null): Promise<VfsMetadataResult> {
    const isDev = !!(process.env.NODE_ENV === 'development' || import.meta.env?.DEV);
    const isSimulatingRemote = !!(typeof process !== 'undefined' && process.env.SIMULATE_PRODUCTION);
    let normalized = normalizeEntitySlug(slug, type).toLowerCase();

    // V27.92 T3(b): papers may be stored under multiple slug forms
    // (arxiv--<id> ~75%, bare <id> ~20%, unknown--<id> ~3.2% content-hash).
    // Each candidate must be hashed to ITS OWN meta shard — a single
    // unknown--<id> form lands on the wrong shard and is unreachable.
    // Non-paper types keep the single-candidate path below.
    const candidates: string[] = type === 'paper'
        ? generatePaperCandidates(normalized)
        : [normalized];
    if (candidates.length === 0) candidates.push(normalized);

    // Strategy 1: Local Development (better-sqlite3)
    if (isDev && typeof window === 'undefined' && !isSimulatingRemote) {
        try {
            const { default: Database } = await import('better-sqlite3');
            const path = await import('path');
            const dbPath = path.resolve(process.cwd(), 'data/meta.db');
            const fs = await import('fs/promises');
            const exists = await fs.stat(dbPath).catch(() => null);
            if (exists) {
                const db = new Database(dbPath, { readonly: true });
                for (const c of candidates) {
                    const rows = db.prepare(SELECT_SQL).all(c, c, c, c, c) as any[];
                    const pick = rows.length ? pickRouteTyped(rows, c, type) : null;
                    if (pick && 'row' in pick) { db.close(); return { data: pick.row, source: 'local-sqlite' }; }
                    if (pick && 'overflow' in pick) { db.close(); return { transient: true }; }
                }
                db.close();
            }
        } catch (e: any) {
            console.warn('[VFS-Metadata] Local DB failed:', e.message);
            // Local-dev infra failure is transient, not a confirmed miss.
            return { transient: true };
        }
        return { notFound: true };
    }

    // Strategy 2: Production VFS — query meta-NN.db via R2 Range Read SQLite
    if (!isDev || isSimulatingRemote) {
        const r2Bucket = env?.R2_ASSETS;
        const shouldSimulate = isDev;
        const start = Date.now(); // V27.91: bound total miss latency across probes
        // V27.97: any per-op timeout / shard error / budget-bail leaves a shard
        // un-probed-cleanly, so the result is inconclusive -> transient, never a
        // false 404. Only an all-clean exhaustion may report notFound.
        let inconclusive = false;

        try {
            const manifest = await loadManifest(r2Bucket, shouldSimulate);
            const shardCount = manifest?.partitions?.meta_shards || 96;

            // Per-candidate -> its own shard. Dedup shards so distinct opens stay
            // small (<= ~3-5 papers, 1 for non-paper) and respect CF's
            // 50-subrequest limit. We keep the candidate set per shard so the SQL
            // binding matches the form that hashed there.
            const shardForms = new Map<number, string[]>();
            for (const c of candidates) {
                const idx = xxhash64Mod(c, shardCount);
                const arr = shardForms.get(idx);
                if (arr) arr.push(c); else shardForms.set(idx, [c]);
            }

            // B4 — id-index absence oracle + index-driven candidate resolution.
            // The slim v2 index enumerates every resolvable form, so a loaded
            // index is authoritative over presence:
            //   - candidate hits  -> probe ONLY the resolved shard(s) (the paper
            //     multi-form fan-out collapses to the real shard, killing the
            //     cold-open storm that drove /paper/<id> into 503s).
            //   - NO candidate hits -> proven absence -> immediate notFound, ZERO
            //     cold-shard probes (clean honest 404, no budget timeout).
            //   - index absent/refused -> DEGRADE to the prior fan-out EXACTLY.
            // The index never decides DATA (the real SELECT still runs), so a
            // collision only mis-routes, never falsely 404s a real entity.
            // B4 coherence gate: absence proof allowed ONLY when the served
            // manifest's build_id matches the index's stamped build_id (same bake,
            // this request). Incoherent -> no zero-probe notFound, no destructive
            // shrink — only non-destructive reorder (full fan-out still probed).
            const resolution = await resolveShardsForCandidates(shardForms, candidates, env, manifest?.build_id);
            if (resolution.absenceProven) {
                return { notFound: true };
            }

            // V27.91: budget-gated — bail before a probe once the wall-clock
            // budget is spent, so a dead-URL miss returns a fast soft-404 instead
            // of timing out into a 524.
            for (const [shardIdx, forms] of resolution.orderedShards) {
                if (Date.now() - start > FALLBACK_BUDGET_MS) { inconclusive = true; break; }
                const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
                try {
                    const engine = await withOpTimeout(
                        getCachedDbConnection(r2Bucket, shouldSimulate, dbName),
                        OP_TIMEOUT_MS, `open:${dbName}`);
                    for (const form of forms) {
                        const rows = await withOpTimeout(
                            executeSql(engine.sqlite3, engine.db, SELECT_SQL, [form, form, form, form, form]),
                            OP_TIMEOUT_MS, `sql:${dbName}`);
                        if (rows.length > 0) {
                            // C4 Stage 1: enforce the route type. If this shard's
                            // co-resident rows include a row of the requested type,
                            // return it. A wrong-type-only shard is a clean non-match
                            // (keep probing). Candidate OVERFLOW with no authoritative
                            // route-typed exact row is INCONCLUSIVE -> transient (the
                            // real row may sit in the un-fetched tail), never notFound.
                            const pick = pickRouteTyped(rows, form, type);
                            if (pick && 'row' in pick) return { data: pick.row, source: `vfs:${dbName}` };
                            if (pick && 'overflow' in pick) inconclusive = true;
                        }
                    }
                } catch (e: any) {
                    inconclusive = true; // timeout OR shard error -> not a clean miss
                    console.warn(`[VFS-Metadata] shard probe ${isOpTimeout(e) ? 'timeout' : 'failed'} ${dbName}:`, e.message);
                }
            }

            // V27.99: the +/-2 adjacent-shard fallback was removed. The V27.98
            // read-only population probe over all 547,137 prod entities found it
            // uniquely resolves ZERO (fallback-only = 0.00%) — per-candidate
            // sharding already covers every routable entity. Dropping it means a
            // cold dead non-paper URL does just its 1 primary candidate open (not
            // 1 + up to 4 cold fallback opens), completes inside the budget, and
            // reaches clean exhaustion -> reliable notFound/404 instead of a
            // budget-bail soft-200/transient.
        } catch (e: any) {
            // Manifest load / unexpected failure: inconclusive, never a clean miss.
            console.warn(`[VFS-Metadata] SQLite query failed for ${normalized}:`, e.message);
            return { transient: true };
        }

        return inconclusive ? { transient: true } : { notFound: true };
    }

    return { notFound: true };
}
