import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
// @ts-ignore — JS ESM module (no .d.ts); tested for its runtime contract.
import { sha256File, discoverServedArtifacts, buildCycleManifest, emitCycleManifest, finalizePack } from '../../scripts/factory/lib/pack-finalizer.js';
// @ts-ignore — JS ESM module (no .d.ts); used to build a REAL complete rankings DB set.
import { exportRankingsDbs } from '../../scripts/factory/lib/rankings-db-exporter.js';
import { RANKINGS_GROUPS, RANKINGS_DB_NAMES } from '../../src/constants/rankings-groups.js';

// Vitest-collected hermetic suite for the R5 Phase-2 cycle-manifest SUBSTRATE in
// pack-finalizer.js (converted 1:1 from the .mjs original), extended by the Founder
// D-352 F-2 repair: emitCycleManifest is a LOCAL / DI substrate with ZERO production
// callers, and finalizePack emits NO cycle manifest at all.

const sha = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');
const FIN = 'export async function finalizePack(';
const finalizerSrc = () => fs.readFileSync(path.resolve(process.cwd(), 'scripts/factory/lib/pack-finalizer.js'), 'utf8').replace(/\r\n/g, '\n');
/** Strip comments so no assertion can ever be satisfied by prose alone. */
const executableJs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
/** finalizePack's body = its signature to end of file (it is the last export). */
const finalizePackBody = (s: string) => s.slice(s.indexOf(FIN));

function makeShardDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-pf-'));
    const bytes: Record<string, Buffer> = {};
    const write = (rel: string, body: Buffer) => {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body);
        bytes[rel.replace(/\\/g, '/')] = body;
    };
    // meta shards + fused + required singletons + reader anchors + rankings + term_index/* + cluster-ann/*
    write('meta-00.db', Buffer.from('META0'));
    write('meta-01.db', Buffer.from('META1'));
    write('meta-02.db', Buffer.from('META2'));
    write('fused-shard-000.bin', Buffer.from('FUSED0'));
    write('fused-shard-001.bin', Buffer.from('FUSED1'));
    write('id-index.bin', Buffer.from('IDINDEX'));
    write('hot-shard.bin', Buffer.from('HOT'));
    write('vector-core.bin', Buffer.from('VEC'));
    write('meta-knowledge.db', Buffer.from('KNOW'));      // reader anchor singleton
    write('meta-report.db', Buffer.from('REPORT'));       // reader anchor singleton
    write('rankings-model.db', Buffer.from('RANKMODEL')); // enters ONLY via the verified member list
    write('term_index/000.bin', Buffer.from('TERM0'));
    write('term_index/nested/001.bin', Buffer.from('TERM1'));
    write('cluster-ann-0.bin', Buffer.from('CANN0'));
    // D-395 served singleton — ENUMERATED + hashed, bytes NEVER rewritten
    write('shards_manifest.json', Buffer.from('{"legacy":true}'));
    // decoy that must NOT be enumerated
    write('scratch.tmp', Buffer.from('IGNORE'));
    return { dir, bytes };
}

describe('pack-finalizer — R5 cycle-manifest emit', () => {
    it('(PF1) discoverServedArtifacts finds every served class + recurses; drops non-served', () => {
        const { dir } = makeShardDir();
        const logicals = discoverServedArtifacts(dir, ['rankings-model.db']).map((a: any) => a.logical);
        for (const l of ['meta-00.db', 'meta-01.db', 'meta-02.db', 'fused-shard-000.bin', 'fused-shard-001.bin',
            'id-index.bin', 'hot-shard.bin', 'vector-core.bin', 'meta-knowledge.db', 'meta-report.db', 'rankings-model.db',
            'term_index/000.bin', 'term_index/nested/001.bin', 'cluster-ann-0.bin']) {
            expect(logicals.includes(l)).toBe(true);
        }
        // D-395 reconciliation: shards_manifest.json is a REQUIRED served singleton.
        expect(logicals.includes('shards_manifest.json')).toBe(true);
        expect(logicals.includes('scratch.tmp')).toBe(false);
    });

    it('(PF2 / integrity triple) each blob key === sha256 of its local bytes', () => {
        const { dir, bytes } = makeShardDir();
        const cm = buildCycleManifest({ buildId: 'run-1-a1-deadbeef', partitions: { meta_shards: 3 }, artifacts: discoverServedArtifacts(dir, ['rankings-model.db']) });
        for (const [logical, key] of Object.entries(cm.blobs) as [string, string][]) {
            expect(key).toBe(sha(bytes[logical]));
            expect(key).toBe(sha256File(path.join(dir, logical)));
        }
        expect(cm.build_id).toBe('run-1-a1-deadbeef');
        expect(cm.partitions).toStrictEqual({ meta_shards: 3 });
    });

    it('(PF3) emitCycleManifest writes cycles/<buildId>/manifest.json enumerating all served artifacts', async () => {
        const { dir, bytes } = makeShardDir();
        const cm = await emitCycleManifest(dir, 'run-9-a2-cafebabe0000', { meta_shards: 3, total_entities: 5 }, ['rankings-model.db']);
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'cycles', 'run-9-a2-cafebabe0000', 'manifest.json'), 'utf8'));
        expect(onDisk).toStrictEqual(cm);
        expect(Object.keys(cm.blobs).length).toBe(Object.keys(bytes).length - 1); // minus the single decoy (scratch.tmp)
        expect(cm.partitions.total_entities).toBe(5);
    });

    it('(PF4) emit HASHES shards_manifest.json WITHOUT modifying its bytes; NO circular nesting', async () => {
        const { dir } = makeShardDir();
        const before = fs.readFileSync(path.join(dir, 'shards_manifest.json'));
        const cm = await emitCycleManifest(dir, 'run-2-a1-0000', { meta_shards: 3 });
        const after = fs.readFileSync(path.join(dir, 'shards_manifest.json'));
        expect(before.equals(after)).toBe(true);                    // legacy manifest byte-identical
        expect(cm.blobs['shards_manifest.json']).toBe(sha(before)); // hashed as a served singleton
        // NO circular dependency: the R5 cycle manifest is a SEPARATE object; it is never
        // written INTO shards_manifest.json.
        expect(JSON.parse(after.toString('utf8')).blobs).toBeUndefined();
        expect(fs.existsSync(path.join(dir, 'cycles', 'run-2-a1-0000', 'manifest.json'))).toBe(true);
    });

    it('(PF5 / RED-restore) mutating one blob byte changes ONLY that key (content-address is real)', () => {
        const { dir } = makeShardDir();
        const base = buildCycleManifest({ buildId: 'b', partitions: { meta_shards: 3 }, artifacts: discoverServedArtifacts(dir, ['rankings-model.db']) });
        fs.writeFileSync(path.join(dir, 'meta-01.db'), Buffer.from('META1-MUTATED')); // real mutation
        const after = buildCycleManifest({ buildId: 'b', partitions: { meta_shards: 3 }, artifacts: discoverServedArtifacts(dir, ['rankings-model.db']) });
        expect(after.blobs['meta-01.db']).not.toBe(base.blobs['meta-01.db']);
        expect(after.blobs['meta-00.db']).toBe(base.blobs['meta-00.db']);
    });

    // ---- D-395 mainline reconciliation: the R5 substrate must NOT weaken the
    // rankings publication authority current main added between the PR base and HEAD.
    it('(PF6) rankings authority intact: assertRankingsDbSet load-bearing, flag AFTER it, no .some() shortcut', () => {
        const src = fs.readFileSync(path.resolve(process.cwd(), 'scripts/factory/lib/pack-finalizer.js'), 'utf8');
        const gate = src.indexOf('assertRankingsDbSet(shardDir, verifyOptsFromEnv());');
        const flag = src.indexOf('partitionCounts.rankings_dbs = true;');
        expect(gate).toBeGreaterThan(-1);          // the complete-set verification still runs
        expect(flag).toBeGreaterThan(gate);        // rankings_dbs becomes true ONLY after it
        // the flag is written EXPLICITLY true exactly once, and NEVER written false
        expect((src.match(/partitionCounts\.rankings_dbs\s*=/g) || []).length).toBe(1);
        expect(/partitionCounts\.rankings_dbs\s*=\s*false/.test(src)).toBe(false);
        // the OBSOLETE any-one-file boolean shortcut must NOT have returned
        expect(src.includes("fsSync.readdirSync(shardDir).some(f => f.startsWith('rankings-')")).toBe(false);
        // no swallowing try/catch may enclose the rankings gate
        expect(src.slice(gate, flag).includes('catch')).toBe(false);
    });

    it('(PF7) served rankings DBs enter the manifest ONLY via the D-395 verified member list', () => {
        const src = fs.readFileSync(path.resolve(process.cwd(), 'scripts/factory/lib/pack-finalizer.js'), 'utf8');
        // D-395 invariant S15: strip the two SANCTIONED tokens; NO other executable lowercase
        // "rankings" reference may remain — i.e. this file carries NO duplicated local list.
        const code = src.split('\n').filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(/rankings/.test(code.replace(/rankings-db-verifier|rankings_dbs/g, ''))).toBe(false);
        // and behaviourally: a DB the authority did NOT verify is NOT enumerated
        const { dir } = makeShardDir();
        expect(discoverServedArtifacts(dir).map((a: any) => a.logical).includes('rankings-model.db')).toBe(false);
        expect(discoverServedArtifacts(dir, ['rankings-model.db']).map((a: any) => a.logical).includes('rankings-model.db')).toBe(true);
    });
});

// Founder D-352 F-2 REPAIR: finalizePack emits NO production cycle manifest. The emit call
// AND its warning-only try/catch were REMOVED, not relocated: no position inside finalizePack
// is a valid end-of-pack barrier (more served artifacts appear after it returns).
describe('pack-finalizer — F-2 repair: no production cycle-manifest emission', () => {
    it('(PF8) finalizePack does NOT invoke emitCycleManifest anywhere in its body', () => {
        const body = executableJs(finalizePackBody(finalizerSrc()));
        expect(/emitCycleManifest\s*\(/.test(body)).toBe(false);   // no call, moved or otherwise
        expect(body.includes('emitCycleManifest')).toBe(false);    // not even a reference
        expect(/verifiedDbSet/.test(body)).toBe(false);            // nor via the old alias
    });

    it('(PF9) the warning-only "emit skipped" swallowing path is ABSENT from the module', () => {
        const src = finalizerSrc(); const code = executableJs(src);
        expect(/emit skipped/.test(src)).toBe(false);              // gone from code AND prose
        expect(/console\.warn\([^)]*R5-CYCLE-MANIFEST/.test(code)).toBe(false);
        expect(/R5-CYCLE-MANIFEST[^\n]*catch/.test(code)).toBe(false);
        // exactly ONE try/catch survives (the pre-existing VFS-TYPES sanity check); a
        // reintroduced emit wrapper would make it two.
        const body = executableJs(finalizePackBody(src));
        expect((body.match(/\btry\s*\{/g) || []).length).toBe(1);
        expect((body.match(/\bcatch\s*\(/g) || []).length).toBe(1);
        expect(body.includes('[VFS-TYPES] Sanity check skipped')).toBe(true);
    });

    it('(PF10) emitCycleManifest has ZERO production callers repository-wide', () => {
        // TRACKED files only (git ls-files): deterministic, and immune to temp files a
        // parallel suite may transiently create under scripts/ or src/.
        const ls = spawnSync('git', ['ls-files', '--', 'scripts', 'src', '.github'], { cwd: process.cwd(), encoding: 'utf8' });
        expect(ls.status, `git ls-files failed: ${ls.stderr}`).toBe(0);
        const files = ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
            .filter((rel) => /\.(js|mjs|cjs|ts|tsx|ya?ml)$/.test(rel))
            .filter((rel) => !/(^|\/)tests?\//.test(rel) && !/\.(test|spec)\.[a-z]+$/.test(rel)); // tests are the sanctioned consumers
        expect(files.length).toBeGreaterThan(100);                 // anti-vacuity: the scan really ran
        const hits: string[] = [];
        for (const rel of files) {
            const raw = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
            // comments are PROSE, not callers: only executable lines may count
            const txt = /\.ya?ml$/.test(rel) ? raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n') : executableJs(raw);
            txt.split('\n').forEach((l, i) => { if (l.includes('emitCycleManifest')) hits.push(`${rel}:${i + 1}:${l.trim()}`); });
        }
        // the ONLY permitted production-surface occurrence is the export DEFINITION itself
        expect(hits.filter((h) => !/export async function emitCycleManifest\(/.test(h))).toStrictEqual([]);
        expect(hits.length).toBe(1); expect(hits[0].startsWith('scripts/factory/lib/pack-finalizer.js:')).toBe(true);
    });

    it('(PF11 / behavioural) a REAL successful finalizePack writes shards_manifest.json and NO cycles/**', async () => {
        const RUN = '900100200'; const ATT = '2'; const HEAD = 'a'.repeat(40);
        const groups: Record<string, any[]> = {};
        for (const g of RANKINGS_GROUPS as string[]) {
            groups[g] = [0, 1].map((i) => ({ id: `hf-model--${g}-${i}`, slug: `${g}-${i}`, name: `${g} ${i}`, type: 'model', author: 'a', summary: 's', fni_score: 90 - i, has_gguf: false }));
        }
        const KEYS = ['RANKINGS_RUN_ID', 'RANKINGS_RUN_ATTEMPT', 'RANKINGS_HEAD_SHA', 'RANKINGS_EXPECT_RUN_ID', 'RANKINGS_EXPECT_HEAD_SHA', 'RANKINGS_MAX_ATTEMPT'];
        const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-pf-rank-')); const shardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-pf-shard-'));
        try {
            Object.assign(process.env, { RANKINGS_RUN_ID: RUN, RANKINGS_RUN_ATTEMPT: ATT, RANKINGS_HEAD_SHA: HEAD });
            await exportRankingsDbs(groups, src);
            for (const n of RANKINGS_DB_NAMES as string[]) fs.copyFileSync(path.join(src, 'data', n), path.join(shardDir, n));
            Object.assign(process.env, { RANKINGS_EXPECT_RUN_ID: RUN, RANKINGS_EXPECT_HEAD_SHA: HEAD, RANKINGS_MAX_ATTEMPT: ATT });
            const partitionCounts: any = {};
            // metaDbs {} keeps this hermetic; the rankings gate + manifest write are real.
            await finalizePack({}, {}, -1, shardDir, shardDir, { packed: 7 }, partitionCounts, async () => {}, () => {}, 'run-1-a2-deadbeefcafe');
            expect(fs.existsSync(path.join(shardDir, 'shards_manifest.json'))).toBe(true);  // legacy artifact intact
            expect(partitionCounts.rankings_dbs).toBe(true);                                // rankings gate really ran
            expect(fs.existsSync(path.join(shardDir, 'cycles'))).toBe(false);               // NO cycle manifest at all
            expect(fs.existsSync(path.join(shardDir, 'cycles', 'run-1-a2-deadbeefcafe', 'manifest.json'))).toBe(false);
            const stray = (fs.readdirSync(shardDir, { recursive: true } as any) as string[]).map((f) => String(f).replace(/\\/g, '/'));
            expect(stray.filter((f) => f.includes('cycles/') || /(^|\/)manifest\.json$/.test(f))).toStrictEqual([]);
        } finally {
            for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
            for (const d of [src, shardDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
        }
    });

    it('(PF12) VACUUM is intact and is NOT presented as the cycle-manifest fix', () => {
        const src = finalizerSrc(); const body = executableJs(finalizePackBody(src));
        expect(body.includes('db.exec("VACUUM;")')).toBe(true); expect((body.match(/VACUUM;/g) || []).length).toBe(1);  // still runs, exactly once
        const prose = finalizePackBody(src);                               // comments included
        for (const re of [/moved (after|below|past) (the )?VACUUM/i, /relocat\w* .{0,40}VACUUM/i, /VACUUM[^\n]{0,80}(fixes|closes|resolves)/i]) expect(re.test(prose)).toBe(false);
        expect(prose.includes('is NOT the fix for that defect')).toBe(true);
    });

    it('(PF13) the exported helper remains usable ONLY as a local/DI substrate', async () => {
        expect(typeof emitCycleManifest).toBe('function');                 // still callable by tests/DI
        const { dir } = makeShardDir();
        const cm = await emitCycleManifest(dir, 'di-substrate-1', { meta_shards: 3 });
        expect(fs.existsSync(path.join(dir, 'cycles', 'di-substrate-1', 'manifest.json'))).toBe(true); expect(Object.keys(cm.blobs).length).toBeGreaterThan(0);
        // ...and it performs a LOCAL FILESYSTEM WRITE ONLY: no transport of any kind
        const src = finalizerSrc(); const helper = src.slice(src.indexOf('export async function emitCycleManifest('), src.indexOf(FIN));
        for (const t of ['r5-staging', 'stageCycle', 'r2-bridge', 'putObject', 'S3Client', 'fetch(', 'upload']) expect(helper.includes(t)).toBe(false);
    });

    it('(PF14) the FALSE absolute "never PUT in production" claim is absent from the repaired sources', () => {
        const acc = fs.readFileSync(path.resolve(process.cwd(), 'scripts/factory/acceptance-staged-cycle.js'), 'utf8');
        for (const rel of ['scripts/factory/lib/pack-finalizer.js', 'scripts/factory/acceptance-staged-cycle.js', '.github/workflows/factory-upload.yml']) {
            // whitespace-normalised: a LINE-WRAPPED reintroduction must still be caught
            const txt = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8').replace(/\n\s*(\*|\/\/|#)?\s*/g, ' ').replace(/\s+/g, ' ');
            expect(/never PUT in production/i.test(txt), `${rel}: "never PUT in production"`).toBe(false);
            expect(/uploader EXCLUDES data\/cycles\//i.test(txt), `${rel}: uploader-exclusion`).toBe(false);
        }
        // the corrected contract states the ACTUAL Phase-2 truth (prose is line-wrapped)
        const fin = finalizerSrc().replace(/\n\s*\*?\s*/g, ' ').replace(/\s+/g, ' ');
        for (const re of [/no production caller/i, /local filesystem write/i, /separate Founder activation ruling/i, /end-of-pack barrier/i]) expect(re.test(fin)).toBe(true);
        // no comment may still claim a production manifest is emitted at finalize time
        expect(/production\s+cycle manifest is emitted at FINALIZE time/i.test(acc)).toBe(false);
        expect(acc.includes('ZERO production callers')).toBe(true);
    });
});
