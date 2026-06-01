import { normalizeEntitySlug } from './entity-cache-reader-core.js';
import { getCachedDbConnection, loadManifest, executeSql } from '../lib/sqlite-engine.js';
import { xxhash64Mod } from './xxhash64.js';
import { generatePaperCandidates } from '../lib/slug-helper.js';
import { env } from 'cloudflare:workers';

// V27.91: wall-clock budget for the multi-shard probing below. A miss
// (genuinely-dead URL, e.g. /paper/<arxivid> not in corpus) must not run the
// full cold R2-VFS open sequence into CF's ~30s limit and 524 Googlebot. Real
// entities hit an early probe and return before exhausting the budget, so this
// cannot regress them.
const FALLBACK_BUDGET_MS = 6000;

const SELECT_SQL = 'SELECT * FROM entities WHERE slug = ? OR id = ? LIMIT 1';

export async function resolveVfsMetadata(type: string, slug: string, locals: any = null) {
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
                    const row = db.prepare(SELECT_SQL).get(c, c);
                    if (row) { db.close(); return { data: row, source: 'local-sqlite' }; }
                }
                db.close();
            }
        } catch (e: any) {
            console.warn('[VFS-Metadata] Local DB failed:', e.message);
        }
        return null;
    }

    // Strategy 2: Production VFS — query meta-NN.db via R2 Range Read SQLite
    if (!isDev || isSimulatingRemote) {
        const r2Bucket = env?.R2_ASSETS;
        const shouldSimulate = isDev;
        const start = Date.now(); // V27.91: bound total miss latency across probes

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

            // V27.91: budget-gated — bail before a probe once the wall-clock
            // budget is spent, so a dead-URL miss returns a fast soft-404 instead
            // of timing out into a 524.
            for (const [shardIdx, forms] of shardForms) {
                if (Date.now() - start > FALLBACK_BUDGET_MS) break;
                const dbName = `meta-${String(shardIdx).padStart(2, '0')}.db`;
                try {
                    const engine = await getCachedDbConnection(r2Bucket, shouldSimulate, dbName);
                    for (const form of forms) {
                        const rows = await executeSql(engine.sqlite3, engine.db, SELECT_SQL, [form, form]);
                        if (rows.length > 0) {
                            return { data: rows[0], source: `vfs:${dbName}` };
                        }
                    }
                } catch (e: any) {
                    console.warn(`[VFS-Metadata] shard probe failed ${dbName}:`, e.message);
                }
            }

            // Fallback: adjacent shards of the primary candidate (hash collision
            // or slug mismatch not covered by the candidate forms). Budget-gated.
            const primaryIdx = xxhash64Mod(candidates[0], shardCount);
            fallback: for (let offset = 1; offset <= 2; offset++) {
                for (const delta of [offset, -offset]) {
                    if (Date.now() - start > FALLBACK_BUDGET_MS) break fallback;
                    const fallbackIdx = ((primaryIdx + delta) % shardCount + shardCount) % shardCount;
                    if (shardForms.has(fallbackIdx)) continue; // already probed
                    const fallbackDb = `meta-${String(fallbackIdx).padStart(2, '0')}.db`;
                    try {
                        const eng = await getCachedDbConnection(r2Bucket, shouldSimulate, fallbackDb);
                        for (const form of candidates) {
                            const rows = await executeSql(eng.sqlite3, eng.db, SELECT_SQL, [form, form]);
                            if (rows.length > 0) {
                                return { data: rows[0], source: `vfs:${fallbackDb}(fallback)` };
                            }
                        }
                    } catch {}
                }
            }
        } catch (e: any) {
            console.warn(`[VFS-Metadata] SQLite query failed for ${normalized}:`, e.message);
        }
    }

    return null;
}
