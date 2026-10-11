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
export const idxFor = (bid: string, ents: any[]) => buildIndexBuffer(
    ents.flatMap(e => [{ form: e.id, shardIdx: xxhash64Mod(e.slug, SH) }, { form: e.slug, shardIdx: xxhash64Mod(e.slug, SH) }]), bid);

export const twin = (id: string, slug: string, type = 'model') =>
    ({ id, slug, type, name: slug, author: 'acme', source: 'huggingface', _db: dbOf(slug.toLowerCase()) });

export async function callRoute(GET: any, id: string) {
    const res = await GET({ params: { id }, url: new URL(`https://x/api/v1/entity/${id}`), request: new Request('https://x') } as any);
    return { status: res.status, body: await res.json(), cc: res.headers.get('Cache-Control') };
}
