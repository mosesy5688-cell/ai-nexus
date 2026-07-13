/**
 * SRS-1 — C4-IDENTITY-PARITY (tier-1, hermetic, EXEC). [D-2026-0713-330 + corrections D-2026-0713-331]
 * Producer stores TWO typed records sharing ONE slug, co-resident on the xxhash64(slug) meta shard. Drives the
 * REAL resolver + REAL entity/compare/vfs handlers over a shard-FAITHFUL mock DB (honors ORDER BY (id/umid)+LIMIT
 * 26) + REAL MCP formatter + OpenAPI + SDK mapper: deterministic type-aware resolution, both twins preserved, bare
 * collision + candidate-overflow + type-conflict surfaced explicitly (never false unique/FOUND); repeat+reversed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { xxhash64Mod } from '../../src/utils/xxhash64.js';

vi.mock('cloudflare:workers', () => ({ env: { R2_ASSETS: {} } }));

const SHARDS = 16;
const lc = (v: any) => String(v).toLowerCase();
const home = (r: any) => xxhash64Mod(lc(r.slug || r.id), SHARDS);
// Shard-faithful DB honoring the corrected `ORDER BY (id=?) DESC,(umid=?) DESC,type ASC,id ASC LIMIT N` (order keys = last 2 binds) so the 26-row window / overflow boundary / exact-id-prioritization-under-truncation are genuinely exercised.
let DB: any[] = [];
const executeSql = vi.fn(async (_s3: any, _db: any, sql: string, bind: any[]) => {
    const b = bind || [], hasOrder = /ORDER BY/i.test(sql), lm = sql.match(/LIMIT\s+(\d+)/i);
    const limit = lm ? Number(lm[1]) : Infinity;
    const oid = hasOrder ? lc(b[b.length - 2]) : '', oum = hasOrder ? lc(b[b.length - 1]) : '';
    const f = new Set((hasOrder ? b.slice(0, -2) : b).map(lc));
    let out = DB.filter((r: any) => (r.slug && f.has(lc(r.slug)))
        || (f.has(lc(r.id)) && xxhash64Mod(lc(r.id), SHARDS) === home(r))
        || (r.umid && f.has(lc(r.umid)) && xxhash64Mod(lc(r.umid), SHARDS) === home(r)));
    if (hasOrder) out = out.slice().sort((x: any, y: any) =>
        ((lc(y.id) === oid ? 1 : 0) - (lc(x.id) === oid ? 1 : 0))                                  // (id = ?) DESC
        || ((y.umid && lc(y.umid) === oum ? 1 : 0) - (x.umid && lc(x.umid) === oum ? 1 : 0))        // (umid = ?) DESC
        || (lc(x.type) < lc(y.type) ? -1 : lc(x.type) > lc(y.type) ? 1 : 0)                         // type ASC
        || (lc(x.id) < lc(y.id) ? -1 : lc(x.id) > lc(y.id) ? 1 : 0));                               // id ASC
    return out.slice(0, limit);
});
const getCachedDbConnection = vi.fn(async () => ({ sqlite3: {}, db: {} }));
vi.mock('../../src/lib/sqlite-engine.js', () => ({
    getCachedDbConnection: (...a: any[]) => getCachedDbConnection(...a),
    executeSql: (...a: any[]) => executeSql(...a),
    loadManifest: vi.fn(async () => ({ _etag: 'etag-c4', partitions: { meta_shards: SHARDS }, build_id: 'bid-c4' })),
}));
vi.mock('../../src/lib/entity-absence-oracle.js', () => ({
    resolveShardsForCandidates: vi.fn(async (sf: Map<number, string[]>) => ({ absenceProven: false, orderedShards: [...sf.entries()], indexLoaded: false })),
}));
vi.mock('../../src/utils/packet-loader.js', () => ({ fetchBundleReadme: vi.fn(async () => ({ readme: null, demo: null })), loadEntityStreams: vi.fn() }));

import { resolveEntityMatch, prefixEntityType, MAX_CANDIDATES, MAX_PUBLIC_CANDIDATES, CANDIDATE_FETCH_LIMIT } from '../../src/lib/entity-match-resolver.js';
import { GET as ENTITY_GET } from '../../src/pages/api/v1/entity/[...id].js';
import { GET as COMPARE_GET } from '../../src/pages/api/v1/compare.js';
import { resolveVfsMetadata, isVfsFound } from '../../src/utils/vfs-metadata-provider.js';
import { buildExplainResult } from '../../src/lib/mcp-explain.js';
const schema = createRequire(import.meta.url)('../../src/data/openapi-schema.json');

const row = (id: string, type: string, slug: string, x: any = {}) =>
    ({ id, type, slug, name: `${type}:${slug}`, author: slug.split('--')[0], source: 'huggingface',
       fni_score: 60, fni_a: 55, fni_p: 70, fni_r: 40, fni_q: 80, downloads: 100, stars: 5, license: 'apache-2.0', ...x });
const twins = (slug: string, n: number, type: (i: number) => string, tag: string) =>   // >= LIMIT co-resident twins on ONE slug
    Array.from({ length: n }, (_, i) => row(`hf-${type(i)}--${slug}--${tag}${i}`, type(i), slug));

// 5 reproduced conflict classes (gate §6); internal keys planted to prove no leak.
const B_M = row('hf-model--google-bert--bert-base-uncased', 'model', 'google-bert--bert-base-uncased', { umid: 'umid-bert-model-000', _dbSort: 3, _score: 9.9, _source: 'internal' });
const B_D = row('hf-dataset--google-bert--bert-base-uncased', 'dataset', 'google-bert--bert-base-uncased');
const ML_M = row('hf-model--sentence-transformers--all-minilm-l6-v2', 'model', 'sentence-transformers--all-minilm-l6-v2');
const ML_D = row('hf-dataset--sentence-transformers--all-minilm-l6-v2', 'dataset', 'sentence-transformers--all-minilm-l6-v2');
const K_M = row('hf-model--khaledreda--all-minilm-l6-test_model', 'model', 'khaledreda--all-minilm-l6-test_model');
const K_D = row('hf-dataset--khaledreda--all-minilm-l6-test_model', 'dataset', 'khaledreda--all-minilm-l6-test_model');
const N_M = row('gh-model--nielsrogge--transformers-tutorials', 'model', 'nielsrogge--transformers-tutorials');
const N_T = row('gh-tool--nielsrogge--transformers-tutorials', 'tool', 'nielsrogge--transformers-tutorials');
const J_M = row('hf-model--jackrong--qwopus35-9b-coder-mtp-gguf', 'model', 'jackrong--qwopus35-9b-coder-mtp-gguf');
const J_D = row('hf-dataset--jackrong--qwopus35-9b-coder-mtp-gguf', 'dataset', 'jackrong--qwopus35-9b-coder-mtp-gguf');
const WHISPER = row('hf-model--openai--whisper-large-v3', 'model', 'openai--whisper-large-v3');   // model-only control
const GSM8K = row('hf-dataset--openai--gsm8k', 'dataset', 'openai--gsm8k');                        // dataset-only control
const PAPER = row('arxiv-paper--2401.00001', 'paper', 'arxiv--2401.00001');                        // paper control
const CONFLICT = row('hf-model--misclass--phantom', 'dataset', 'misclass--phantom');               // id prefix != stored type
const PAIRS = [
    { n: 'bert', a: B_M, b: B_D, slug: 'google-bert--bert-base-uncased', tb: 'dataset' },
    { n: 'all-MiniLM', a: ML_M, b: ML_D, slug: 'sentence-transformers--all-minilm-l6-v2', tb: 'dataset' },
    { n: 'khaledreda', a: K_M, b: K_D, slug: 'khaledreda--all-minilm-l6-test_model', tb: 'dataset' },
    { n: 'nielsrogge', a: N_M, b: N_T, slug: 'nielsrogge--transformers-tutorials', tb: 'tool' },
    { n: 'jackrong', a: J_M, b: J_D, slug: 'jackrong--qwopus35-9b-coder-mtp-gguf', tb: 'dataset' },
];
const ALL = [B_M, B_D, ML_M, ML_D, K_M, K_D, N_M, N_T, J_M, J_D, WHISPER, GSM8K, PAPER, CONFLICT];
beforeEach(() => { DB = [...ALL]; executeSql.mockClear(); getCachedDbConnection.mockReset(); getCachedDbConnection.mockResolvedValue({ sqlite3: {}, db: {} }); });

async function entityGet(id: string) {
    const u = new URL(`https://free2aitools.com/api/v1/entity/${encodeURIComponent(id)}`);
    const res = await (ENTITY_GET as any)({ params: { id }, url: u, request: new Request(u.href) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}
async function compareGet(ids: string[]) {
    const u = new URL(`https://free2aitools.com/api/v1/compare?ids=${encodeURIComponent(ids.join(','))}`);
    const res = await (COMPARE_GET as any)({ url: u, request: new Request(u.href) });
    return { status: res.status, body: await res.json() };
}

describe('C4-IDENTITY-PARITY (resolver) — conflict classes, controls, determinism, overflow', () => {
    for (const p of PAIRS) {
        it(`${p.n}: exact typed ids each -> FOUND own type; bare slug -> AMBIGUOUS; REVERSED == identical`, () => {
            const both = [p.a, p.b], amb: any = resolveEntityMatch(p.slug, null, both);
            expect((resolveEntityMatch(p.a.id, null, both) as any).row.type).toBe('model'); expect((resolveEntityMatch(p.b.id, null, both) as any).row.type).toBe(p.tb);
            expect(amb.kind).toBe('AMBIGUOUS'); expect(amb.candidates).toHaveLength(2);
            expect(amb.candidates.map((c: any) => Object.keys(c).sort().join())).toEqual(['id,type', 'id,type']);
            expect(resolveEntityMatch(p.a.id, null, [p.b, p.a])).toEqual(resolveEntityMatch(p.a.id, null, both)); // M2 determinism
            expect(resolveEntityMatch(p.slug, null, [p.b, p.a])).toEqual(amb);                                    // reversed rows == identical
        });
    }
    it('controls: whisper model-only + bare -> model; gsm8k -> dataset; paper -> paper; absent -> NOT_FOUND', () => {
        expect((resolveEntityMatch('openai--whisper-large-v3', null, [WHISPER]) as any).row.type).toBe('model'); expect((resolveEntityMatch(GSM8K.id, null, [GSM8K]) as any).row.type).toBe('dataset');
        expect((resolveEntityMatch(PAPER.id, null, [PAPER]) as any).row.type).toBe('paper'); expect(resolveEntityMatch('hf-model--nonexistent-org--zzz', null, []).kind).toBe('NOT_FOUND');
    });
    it('typed miss -> NOT_FOUND (never another type); UMID P2; IDENTITY_TYPE_CONFLICT; route-type enforcement', () => {
        expect(resolveEntityMatch('hf-dataset--openai--whisper-large-v3', null, [WHISPER]).kind).toBe('NOT_FOUND'); expect((resolveEntityMatch('umid-bert-model-000', null, [B_M, B_D]) as any).row.id).toBe(B_M.id); // P2 umid
        expect(resolveEntityMatch(CONFLICT.id, null, [CONFLICT]).kind).toBe('IDENTITY_TYPE_CONFLICT'); expect(resolveEntityMatch('openai--whisper-large-v3', 'dataset', [WHISPER]).kind).toBe('NOT_FOUND');
        expect((resolveEntityMatch(B_M.slug, 'model', [B_M, B_D]) as any).row.type).toBe('model'); expect((resolveEntityMatch(B_M.slug, 'dataset', [B_M, B_D]) as any).row.type).toBe('dataset'); // route wins over id-prefix
    });
    it('prefixEntityType decodes prefixes; bounded fail-explicit; no leak fields; OVERFLOW downgrades fallback + flags', () => {
        expect([prefixEntityType('hf-model--a--b'), prefixEntityType('gh-tool--a--b'), prefixEntityType('arxiv--x'), prefixEntityType('benchmark--o--m'), prefixEntityType('a--b')])
            .toEqual(['model', 'tool', 'paper', 'benchmark', null]);
        const many = Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) => row(`hf-model--org--shared-${i}`, i % 2 ? 'model' : 'dataset', 'org--shared'));
        const big: any = resolveEntityMatch('org--shared', null, many); expect(big.kind).toBe('AMBIGUOUS'); expect(big.candidate_overflow).toBe(true); expect(big.candidates.length).toBe(MAX_CANDIDATES); // >25 unique -> flagged + capped, NOT collapsed
        expect(resolveEntityMatch('hf-model--org--shared-3', null, many).kind).toBe('FOUND'); // exact stays authoritative under overflow
        expect((resolveEntityMatch(B_M.slug, null, [B_M, B_D]) as any).candidate_overflow).toBeUndefined(); // 2 twins: no flag
        const s = JSON.stringify((resolveEntityMatch(B_M.slug, null, [B_M, B_D]) as any).candidates);
        for (const k of ['_dbSort', '_score', '_source', 'umid', 'slug', 'downloads']) expect(s).not.toContain(k);
    });
});
describe('C4-IDENTITY-PARITY (entity API) — 200 / 404 / 409 / 503 + candidate overflow', () => {
    it('exact typed model id -> 200 model (was the dataset rowid-winner); dataset id -> 200 dataset', async () => {
        const m = await entityGet(B_M.id), d = await entityGet(B_D.id);
        expect([m.status, m.body.entity.type, m.body.entity.canonical_id]).toEqual([200, 'model', B_M.id]); expect([d.status, d.body.entity.type]).toEqual([200, 'dataset']);
    });
    it('bare colliding slug -> 409 AMBIGUOUS_ENTITY_ID with EXACT body + no-store (no overflow flag at 2 twins)', async () => {
        const r = await entityGet('google-bert--bert-base-uncased'); expect([r.status, r.headers.get('Cache-Control')]).toEqual([409, 'no-store']);
        expect(r.body).toEqual({ error: 'Ambiguous entity identifier', code: 'AMBIGUOUS_ENTITY_ID', requested_id: 'google-bert--bert-base-uncased', candidates: [{ id: B_D.id, type: 'dataset' }, { id: B_M.id, type: 'model' }] });
    });
    it('exact id whose stored type conflicts with prefix -> 409 IDENTITY_TYPE_CONFLICT', async () => {
        const r = await entityGet(CONFLICT.id);
        expect([r.status, r.body.code, r.body.requested_id]).toEqual([409, 'IDENTITY_TYPE_CONFLICT', CONFLICT.id]);
    });
    it('T1 26+ co-resident twins with an EXACT typed id present+prioritized -> 200 exact row (not truncated out)', async () => {
        const EXACT = 'hf-model--bulk--overflow'; DB = [...twins('bulk--overflow', 26, () => 'dataset', 'd'), row(EXACT, 'model', 'bulk--overflow')]; // 26 dataset fillers sort BEFORE model; only (id=?) keeps the exact in the LIMIT-26 window
        expect(DB.length).toBe(27); const r = await entityGet(EXACT); // exact model id prioritized into the LIMIT-26 window
        expect([r.status, r.body.entity?.type, r.body.entity?.canonical_id]).toEqual([200, 'model', EXACT]);
    });
    it('T2 26 unique bare-slug twins, NO exact -> 409 AMBIGUOUS_ENTITY_ID + candidate_overflow:true (never false FOUND)', async () => {
        DB = twins('bulk--ambig', CANDIDATE_FETCH_LIMIT, (i) => (i % 2 ? 'model' : 'dataset'), 'a'); const r = await entityGet('bulk--ambig'); // 26 unique twins, no exact id
        expect([r.status, r.body.code, r.body.candidate_overflow]).toEqual([409, 'AMBIGUOUS_ENTITY_ID', true]);
        expect([r.body.candidates.length, r.headers.get('Cache-Control'), r.body.entity]).toEqual([MAX_PUBLIC_CANDIDATES, 'no-store', undefined]);
    });
    it('clean typed miss -> 404 (never the model twin); genuinely absent -> 404; transient shard error -> 503+Retry-After+no-store', async () => {
        expect((await entityGet('hf-dataset--openai--whisper-large-v3')).status).toBe(404); // typed miss, never the model twin
        DB = []; expect((await entityGet('hf-model--nonexistent-org--zzz')).status).toBe(404); // genuinely absent
        getCachedDbConnection.mockRejectedValue(new Error('transient VFS open failure')); DB = [B_M, B_D];
        const r = await entityGet('hf-model--google-bert--bert-base-uncased');
        expect([r.status, r.headers.get('Retry-After'), r.headers.get('Cache-Control')]).toEqual([503, '2', 'no-store']);
    });
    it('controls whisper/paper -> 200 correct type; no leak keys; fni_s null+note; repeated deterministic', async () => {
        expect((await entityGet(WHISPER.id)).body.entity.type).toBe('model'); expect((await entityGet(PAPER.id)).body.entity.type).toBe('paper');
        const r = await entityGet(B_M.id);
        for (const k of ['_dbSort', '_score', '_source']) expect(JSON.stringify(r.body.entity)).not.toContain(k);
        expect(r.body.entity.fni.factors.semantic).toBeNull(); expect(r.body.entity.fni.factors.semantic_note).toMatch(/query-time baseline/i);
        const runs = await Promise.all([entityGet(B_M.id), entityGet(B_M.id), entityGet(B_M.id)]);
        expect(runs.map(x => `${x.status}:${x.body.entity?.type}`)).toEqual(['200:model', '200:model', '200:model']);
    });
});
describe('C4-IDENTITY-PARITY (compare API) — batch envelope + ambiguity + overflow + type-conflict parity', () => {
    it('T5 exact-id twin pair each returns its own type (found:true); bare collision -> additive ambiguity in HTTP 200 batch', async () => {
        const pair = await compareGet([B_M.id, B_D.id]), byId = Object.fromEntries(pair.body.entities.map((e: any) => [e.id, e]));
        expect([pair.status, byId[B_M.id].found, byId[B_M.id].type, byId[B_D.id].type]).toEqual([200, true, 'model', 'dataset']);
        const r = await compareGet(['google-bert--bert-base-uncased', WHISPER.id]);
        const amb = r.body.entities.find((e: any) => e.id === 'google-bert--bert-base-uncased');
        expect(r.status).toBe(200); expect([amb.found, amb.ambiguous, amb.code, amb.candidate_overflow]).toEqual([false, true, 'AMBIGUOUS_ENTITY_ID', undefined]);
        expect(amb.candidates.map((c: any) => c.type).sort()).toEqual(['dataset', 'model']);
        expect(r.body.entities.find((e: any) => e.id === WHISPER.id).found).toBe(true); // clean id still resolves
    });
    it('request order + clean miss preserved; no leak keys; entity<->compare type + identity parity', async () => {
        const r = await compareGet([WHISPER.id, 'hf-model--totally--absent', GSM8K.id]);
        expect(r.body.entities.map((e: any) => e.id)).toEqual([WHISPER.id, 'hf-model--totally--absent', GSM8K.id]);
        expect(r.body.entities[1].found).toBe(false); expect(JSON.stringify(r.body.entities)).not.toContain('_dbSort');
        const e = await entityGet(ML_M.id), cRow = (await compareGet([ML_M.id, WHISPER.id])).body.entities.find((x: any) => x.id === ML_M.id); // search-returned typed id
        expect([e.body.entity.type, cRow.type, e.body.entity.canonical_id]).toEqual(['model', 'model', cRow.id]);
    });
    it('T4 >25 unique bare twins -> HTTP 200 per-item ambiguity + candidate_overflow:true (list capped 25)', async () => {
        DB = [...twins('bulk--cmp', CANDIDATE_FETCH_LIMIT, (i) => (i % 2 ? 'model' : 'dataset'), 'c'), WHISPER];
        const r = await compareGet(['bulk--cmp', WHISPER.id]), item = r.body.entities.find((e: any) => e.id === 'bulk--cmp');
        expect(r.status).toBe(200); expect([item.found, item.ambiguous, item.code, item.candidate_overflow]).toEqual([false, true, 'AMBIGUOUS_ENTITY_ID', true]);
        expect([item.candidates.length, r.body.entities.find((e: any) => e.id === WHISPER.id).found]).toEqual([MAX_PUBLIC_CANDIDATES, true]);
    });
    it('T6/T7 exact typed id CONFLICTING type -> found:false + code:IDENTITY_TYPE_CONFLICT + stored candidate (NOT found:true/ambiguous); entity 409 parity', async () => {
        const r = await compareGet([CONFLICT.id, WHISPER.id]), item = r.body.entities.find((e: any) => e.id === CONFLICT.id);
        expect([r.status, item.found, item.code, item.ambiguous]).toEqual([200, false, 'IDENTITY_TYPE_CONFLICT', undefined]);
        expect(item.candidates).toEqual([{ id: CONFLICT.id, type: 'dataset' }]); expect([item.fni_score, item.candidate_overflow]).toEqual([undefined, undefined]); // never a success payload
        const e = await entityGet(CONFLICT.id);   // T7: SAME conflict via the entity 409 envelope, naming the same stored id+type.
        expect([e.status, e.body.code]).toEqual([409, 'IDENTITY_TYPE_CONFLICT']);
        expect(e.body.candidates.map((x: any) => `${x.id}:${x.type}`)).toContain(`${CONFLICT.id}:dataset`);
    });
});
describe('C4-IDENTITY-PARITY (human vfs) — route-type enforcement + overflow', () => {
    beforeEach(() => { process.env.SIMULATE_PRODUCTION = '1'; });   // force prod VFS path (not the dev better-sqlite3 branch)
    afterEach(() => { delete process.env.SIMULATE_PRODUCTION; });
    it('/model twin -> model; /dataset twin -> dataset; /dataset over model-only slug -> notFound; /model control', async () => {
        const m = await resolveVfsMetadata('model', 'google-bert--bert-base-uncased', null), d = await resolveVfsMetadata('dataset', 'google-bert--bert-base-uncased', null);
        const miss = await resolveVfsMetadata('dataset', 'openai--whisper-large-v3', null), ctl = await resolveVfsMetadata('model', 'openai--whisper-large-v3', null);
        expect(isVfsFound(m) && (m as any).data.type).toBe('model'); expect(isVfsFound(d) && (d as any).data.type).toBe('dataset');
        expect((miss as any).notFound).toBe(true); expect(isVfsFound(ctl) && (ctl as any).data.type).toBe('model');
    });
    it('T3 26 same-type twins, uniqueness unprovable -> transient (retryable), never clean notFound / wrong-type', async () => {
        DB = twins('bulk--vfs', CANDIDATE_FETCH_LIMIT, () => 'model', 'm'); const res = await resolveVfsMetadata('model', 'bulk--vfs', null); // 26 same-type: unprovable
        expect([(res as any).transient, (res as any).notFound, isVfsFound(res)]).toEqual([true, undefined, false]);
    });
});
describe('C4-IDENTITY-PARITY (MCP + OpenAPI + SDK)', () => {
    it('T8 MCP explain 409 AMBIGUOUS_ENTITY_ID -> isError + "multiple typed entities" + retry-one-typed-id + candidates (NOT "No entity found")', () => {
        const res = buildExplainResult('google-bert--bert-base-uncased', { status: 409, retryAfter: null, data: { code: 'AMBIGUOUS_ENTITY_ID', candidates: [{ id: B_D.id, type: 'dataset' }, { id: B_M.id, type: 'model' }] } });
        const t = res.content[0].text; expect(res.isError).toBe(true);
        expect(t).toMatch(/AMBIGUOUS/); expect(t).toMatch(/multiple typed entities/i); expect(t).toMatch(/one exact typed canonical id/i);
        expect(t).toContain(B_M.id); expect(t).not.toMatch(/No entity found/i);
    });
    it('T9 MCP explain 409 IDENTITY_TYPE_CONFLICT -> prefix/stored-type conflict wording, NOT "multiple entities"', () => {
        const res = buildExplainResult(CONFLICT.id, { status: 409, retryAfter: null, data: { code: 'IDENTITY_TYPE_CONFLICT', candidates: [{ id: CONFLICT.id, type: 'dataset' }] } });
        const t = res.content[0].text; expect(res.isError).toBe(true);
        expect(t).toMatch(/IDENTITY_TYPE_CONFLICT/); expect(t).toMatch(/typed prefix conflicts with the stored record's type/i); expect(t).toContain(CONFLICT.id);
        expect(t).not.toMatch(/multiple typed entities/i); expect(t).not.toMatch(/No entity found/i); // conflict != multiplicity
    });
    it('MCP explain: 404 still -> genuine "No entity found" (not funneled into ambiguity)', () => {
        const res = buildExplainResult('ghost', { status: 404, retryAfter: null, data: { error: 'Entity not found: ghost' } });
        expect(res.isError).toBeUndefined(); expect(res.content[0].text).toMatch(/No entity found/i);
    });
    it('T10 OpenAPI: entity 409 EntityAmbiguityError (+ candidate_overflow, candidates maxItems 25) + compare ambiguity & type-conflict variants; path set still 10', () => {
        expect(schema.paths['/api/v1/entity/{id}'].get.responses['409'].content['application/json'].schema.$ref).toBe('#/components/schemas/EntityAmbiguityError');
        const err = schema.components.schemas.EntityAmbiguityError;
        expect([err.properties.candidate_overflow.type, err.properties.candidates.maxItems]).toEqual(['boolean', 25]); expect(err.required).not.toContain('candidate_overflow'); // optional
        expect(err.properties.code.enum.slice().sort()).toEqual(['AMBIGUOUS_ENTITY_ID', 'IDENTITY_TYPE_CONFLICT']);
        const oneOf = schema.components.schemas.CompareResponse.properties.entities.items.oneOf;
        const amb = oneOf.find((v: any) => v.properties?.ambiguous);
        expect(amb.properties.code.enum).toEqual(['AMBIGUOUS_ENTITY_ID']); expect([amb.properties.candidate_overflow.type, amb.properties.candidates.maxItems]).toEqual(['boolean', 25]);
        const conf = oneOf.find((v: any) => v.properties?.code?.enum?.[0] === 'IDENTITY_TYPE_CONFLICT' && !v.properties?.ambiguous);
        expect(conf, 'compare identity type-conflict oneOf variant present').toBeTruthy(); expect(conf.properties.found.enum).toEqual([false]);
        expect(conf.required.slice().sort()).toEqual(['candidates', 'code', 'found', 'id']);
        expect([conf.properties.candidates.maxItems, Object.keys(schema.paths).length]).toEqual([25, 10]);
    });
    it('SDK: a 409 maps to the GENERIC Free2AIError, preserving status + body (no subclass swallow)', async () => {
        const { mapHttpError } = await import('../../packages/sdk/src/http/map-error.js');
        const { Free2AIError, Free2AINotFoundError, Free2AIUnavailableError } = await import('../../packages/sdk/src/errors.js');
        const body = { error: 'Ambiguous entity identifier', code: 'AMBIGUOUS_ENTITY_ID', requested_id: 'x', candidates: [] };
        const err = mapHttpError(409, body, new Headers(), {} as any);
        expect(err).toBeInstanceOf(Free2AIError);
        expect(err).not.toBeInstanceOf(Free2AINotFoundError); expect(err).not.toBeInstanceOf(Free2AIUnavailableError);
        expect(err.constructor.name).toBe('Free2AIError'); expect([err.status, err.body]).toEqual([409, body]);
    });
});
