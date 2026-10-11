// ENT-503 route-test harness (shared by the route Z-4 and case-twin suites).
// Mutable substrate state + a SQL mock faithful to the route's WHERE / ORDER BY /
// LIMIT semantics. Imported by vi.mock factories (dynamic import) and by tests.
import { xxhash64Mod } from '../../../src/utils/xxhash64.js';
import { buildIndexBuffer } from './id-index-fixture.js';

export const H = {
    env: { NODE_ENV: 'production', R2_ASSETS: null as any },
    pin: { build_id: 'run-B', _etag: 'etag-pin', partitions: { meta_shards: 96 }, logicalToBlob: null } as any,
    rows: [] as any[],
    shardMode: new Map<string, 'error' | 'slow' | 'stale'>(),
    sqlCalls: 0,
    clock: { t: 0 },
};

export function sqliteEngineMock() {
    return {
        loadManifest: async () => H.pin,
        getCachedDbConnection: async (_b: any, _d: any, dbName: string) => ({ sqlite3: {}, db: { dbName } }),
        executeSql: async (_s: any, db: any, sql: string, bind: any[]) => {
            H.sqlCalls++;
            const mode = H.shardMode.get(db.dbName);
            if (mode === 'error') throw new Error('shard read failed');
            if (mode === 'slow') { H.clock.t += 7000; return []; }
            if (mode === 'stale') return []; // old-build pages: clean miss for a new entity
            // Faithful to the route SQL: WHERE lower(col) IN (forms) when present (else
            // case-sensitive), ORDER BY (id = raw) DESC, (id|slug IN forms) DESC,
            // (lower(id) = key) DESC, (umid = key) DESC, type ASC, id ASC (BINARY), LIMIT 26.
            const ci = /lower\(id\) IN/.test(sql);
            const exactOrder = /ORDER BY \(id = \?\) DESC, \(id IN/.test(sql);
            const k = exactOrder ? (bind.length - 3) / 5 : (bind.length - 2) / 3;
            const forms = new Set(bind.slice(0, k).map((v: any) => String(v)));
            // exact-id key: route (id = raw); pre-F3 SQL (id = key); a fold-only ORDER BY has none.
            const raw = exactOrder ? String(bind[3 * k]) : ci ? null : String(bind[bind.length - 2]);
            const key = String(bind[bind.length - 2]);
            const fold = (v: any) => String(v ?? '').replace(/[A-Z]/g, c => c.toLowerCase());
            const norm = (v: any) => (ci ? fold(v) : String(v ?? ''));
            const hit = H.rows.filter(r => r._db === db.dbName && (forms.has(norm(r.id)) || forms.has(norm(r.slug))));
            const b = (x: boolean) => (x ? 1 : 0);
            const cmp = (x: any, y: any) => (x < y ? -1 : x > y ? 1 : 0);
            return hit.sort((x, y) => (b(y.id === raw) - b(x.id === raw))
                || (exactOrder ? (b(forms.has(y.id) || forms.has(y.slug)) - b(forms.has(x.id) || forms.has(x.slug))) : 0)
                || (b(fold(y.id) === key) - b(fold(x.id) === key))
                || cmp(x.type, y.type) || cmp(x.id, y.id)).slice(0, 26);
        },
    };
}

export const SH = 96;
export const OVER_CAP = 31_666_148; // production size on 2026-10-10 (> 31,457,280 old cap)
export const dbOf = (form: string) => `meta-${String(xxhash64Mod(form, SH)).padStart(2, '0')}.db`;
export const ABSENT = '__reliability_probe_invalid_id__';
export const REAL = { id: 'hf-model--acme--widget', slug: 'acme--widget', type: 'model', name: 'widget', author: 'acme', source: 'huggingface' };
export const NEW = { id: 'hf-model--acme--brandnew', slug: 'acme--brandnew', type: 'model', name: 'brandnew', author: 'acme', source: 'huggingface' };
export const place = (r: any) => ({ ...r, _db: dbOf(r.slug) });
// Production-faithful index build (id-index-generator.js:110-131): rows are
// routed by their RAW slug (pack-db.js:160 computeMetaShardSlot(e.slug || e.id),
// no lowercasing); shards are iterated in slot order; each lowercased form is
// keyed FIRST-WINS (pushKey de-dup), so a case twin on a lower slot claims the
// shared lowercase keys.
export const slotOf = (e: any) => xxhash64Mod(e.slug || String(e.id).toLowerCase(), SH);
export function idxFor(bid: string, ents: any[]) {
    const seen = new Set<string>();
    const entries: { form: string; shardIdx: number }[] = [];
    const ordered = ents.map((e, i) => ({ e, i, s: slotOf(e) })).sort((a, b) => a.s - b.s || a.i - b.i);
    for (const { e, s } of ordered) {
        for (const f of [e.slug, e.id, e.umid]) {
            const k = f ? String(f).toLowerCase() : '';
            if (!k || seen.has(k)) continue;
            seen.add(k); entries.push({ form: k, shardIdx: s });
        }
    }
    return buildIndexBuffer(entries, bid);
}

// A row placed exactly where production writes it: meta-<xxhash64(RAW slug)>.
export const twin = (id: string, slug: string, type = 'model') =>
    ({ id, slug, type, name: slug, author: 'acme', source: 'huggingface', _db: dbOf(slug) });

/** Find a slug stem whose Upper/lower case twins sit on DIFFERENT shards with the
 * UPPERCASE twin on the lower slot (so the first-wins index points at it). */
export function splitTwinStem(): { up: string; lo: string } {
    for (let i = 0; i < 10_000; i++) {
        const up = `Acme--W${i}`, lo = up.toLowerCase();
        const su = xxhash64Mod(up, SH), sl = xxhash64Mod(lo, SH);
        if (su < sl) return { up, lo };
    }
    throw new Error('no split twin stem');
}

export async function callRoute(GET: any, id: string) {
    const res = await GET({ params: { id }, url: new URL(`https://x/api/v1/entity/${id}`), request: new Request('https://x') } as any);
    return { status: res.status, body: await res.json(), cc: res.headers.get('Cache-Control') };
}
