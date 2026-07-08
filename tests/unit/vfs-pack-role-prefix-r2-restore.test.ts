// D-2026-0708-302 — VFS-PACK META-HANDOFF ROLE-SPECIFIC R2 SUB-PREFIXES. HERMETIC, NO network.
// REAL r2-handoff.js backup-dir/restore-dir (incl. its `_manifest.json` restore sidecar +
// last-writer-wins) runs against an in-memory bucket stubbing S3 Put/Get/List (vi.mock of
// r2-helpers.js); REAL vfs-derived-handoff-manifest.mjs generate/verify is driven via its node
// CLI (a `#!` shebang => run, not imported). NOTHING under scripts/factory/lib/ is modified.
// Bug: two backup-dir into ONE ${STAGING} both write
// ${STAGING}_manifest.json; last-writer leaves only .bin => restore drops meta-00.db =>
// FILE_MISSING. Fix (Option 1): each role -> its OWN sub-prefix + OWN _manifest.json.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
vi.mock('../../scripts/factory/lib/r2-helpers.js', () => ({
    createR2Client: () => (globalThis as any).__R2_CLIENT ?? null,
    fetchR2Etags: async () => new Map(),
}));
import {
    backupDirectoryToR2, restoreDirectoryFromR2, backupFileToR2, restoreFileFromR2,
} from '../../scripts/factory/lib/r2-handoff.js';
const MJS = path.resolve(__dirname, '../../scripts/factory/vfs-derived-handoff-manifest.mjs');
function runMjs(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [MJS, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
function makeBucket() {
    const store = new Map<string, Buffer>();
    const client = {
        async send(cmd: any) {
            const n = cmd?.constructor?.name; const i = cmd?.input || {};
            if (n === 'PutObjectCommand') { store.set(i.Key, Buffer.from(i.Body)); return { $metadata: {} }; }
            if (n === 'GetObjectCommand') {
                const b = store.get(i.Key);
                if (!b) { const e: any = new Error(`NoSuchKey ${i.Key}`); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                return { Body: (async function* () { yield b; })(), ContentLength: b.length };
            }
            if (n === 'ListObjectsV2Command') {
                const p = i.Prefix || '';
                return { Contents: [...store.keys()].filter((k) => k.startsWith(p)).sort().map((Key) => ({ Key })), NextContinuationToken: undefined };
            }
            throw new Error(`unhandled ${n}`);
        },
    };
    return { store, client };
}
// .db/.bin clear the 256B non-.zst floor; term_index .zst carry the zstd magic + >=16B.
function bin(s: string, size = 512): Buffer { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = (s.charCodeAt(i % s.length) + i * 7) & 0xff; return b; }
function zst(s: string, size = 48): Buffer { const b = Buffer.alloc(size); b[0] = 0x28; b[1] = 0xb5; b[2] = 0x2f; b[3] = 0xfd; for (let i = 4; i < size; i++) b[i] = (s.charCodeAt(i % s.length) + i * 3) & 0xff; return b; }
const tmpRoots: string[] = [];
function freshTmp(tag: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), `vfs-role-${tag}-`)); tmpRoots.push(d); return d; }
function writeDataTree(root: string): string {
    const data = path.join(root, 'output', 'data');
    fs.mkdirSync(path.join(data, 'term_index', 'aa'), { recursive: true });
    fs.mkdirSync(path.join(data, 'term_index', 'ab'), { recursive: true });
    fs.writeFileSync(path.join(data, 'meta-00.db'), bin('meta00'));
    for (const nm of ['vector-core.bin', 'hot-shard.bin', 'id-index.bin']) fs.writeFileSync(path.join(data, nm), bin(nm));
    fs.writeFileSync(path.join(data, 'term_index', '_manifest.json.zst'), zst('tim'));
    fs.writeFileSync(path.join(data, 'term_index', 'aa', 'aa_0.json.zst'), zst('aa'));
    fs.writeFileSync(path.join(data, 'term_index', 'ab', 'ab_0.json.zst'), zst('ab'));
    return data;
}
const UP = 'U1', RUN = 'R1', ATT = 1;
const STAGING = `state/_handoff/vfs-pack/${UP}/${RUN}/attempt-${ATT}/`;
const PROV = { HANDOFF_UPSTREAM_RUN_ID: UP, HANDOFF_FACTORY_RUN_ID: RUN, HANDOFF_PRODUCER_ATTEMPT: String(ATT), HANDOFF_HEAD_SHA: 'a'.repeat(40), HANDOFF_VFS_PACK_CODE_VERSION: 'vpcv-1' };
const DPROV = { HANDOFF_UPSTREAM_RUN_ID: UP, HANDOFF_FACTORY_RUN_ID: RUN, HANDOFF_RUN_ATTEMPT: String(ATT), HANDOFF_HEAD_SHA: 'a'.repeat(40), HANDOFF_VFS_PACK_CODE_VERSION: 'vpcv-1' };
// CONTENT manifests are content-over-output/data — IDENTICAL regardless of R2 layout
// (sub-prefixing changes WHERE bytes live, never their names/content/hash).
function makeEnv(tag: string) {
    const { store, client } = makeBucket();
    (globalThis as any).__R2_CLIENT = client;
    const root = freshTmp(tag); const dataDir = writeDataTree(root); const emptyRss = freshTmp(`${tag}-rss`);
    const metaPath = path.join(root, 'meta.json'); const warmPath = path.join(root, 'warm.json');
    const g = runMjs(['generate', dataDir, metaPath, '--carrier=vfs-pack-authority', '--ext=.db', `--rss-base=${emptyRss}`], PROV);
    if (g.code !== 0) throw new Error(`meta gen: ${g.stderr}`);
    const gw = runMjs(['generate-warm-read', dataDir, warmPath, '--carrier=vfs-pack-authority'], PROV);
    if (gw.code !== 0) throw new Error(`warm gen: ${gw.stderr}`);
    const manifestSha = crypto.createHash('sha256').update(fs.readFileSync(metaPath)).digest('hex');
    const descriptor: any = {
        schema_version: 1, carrier_type: 'vfs-pack-authority', producer_attempt: ATT, exact_staging_prefix: STAGING,
        manifest_sha256: manifestSha, set_sha256: g.stdout, warm_read_set_sha256: gw.stdout, warm_read_member_count: 6,
        upstream_run_id: UP, factory_run_id: RUN, head_sha: 'a'.repeat(40), vfs_pack_code_version: 'vpcv-1', parent_set_sha256: null, created_at: '2026-07-08T00:00:00.000Z',
    };
    const descPath = path.join(root, 'handoff.json'); fs.writeFileSync(descPath, JSON.stringify(descriptor));
    return { store, root, dataDir, metaPath, warmPath, metaSetSha: g.stdout, warmSetSha: gw.stdout, descriptor, descPath };
}
const vMeta = (d: string, m: string) => runMjs(['verify', d, m, '--carrier=vfs-pack-authority', '--ext=.db']);
const vWarm = (d: string, m: string) => runMjs(['verify-warm-read', d, m, '--carrier=vfs-pack-authority']);
async function produce(env: any, shared: boolean) {
    await backupDirectoryToR2(env.dataDir, shared ? STAGING : `${STAGING}meta/`, { extensions: ['.db'] });
    await backupDirectoryToR2(env.dataDir, shared ? STAGING : `${STAGING}warm/`, { extensions: ['.bin'] });
    await backupDirectoryToR2(path.join(env.dataDir, 'term_index'), `${STAGING}term_index/`);
    await backupFileToR2(env.metaPath, `${STAGING}manifest.json`);
    await backupFileToR2(env.warmPath, `${STAGING}warm-read-manifest.json`);
}
async function recoverByRole(env: any, d: string, o: { metaFrom?: string; warmFrom?: string } = {}) {
    fs.mkdirSync(d, { recursive: true });
    await restoreDirectoryFromR2(o.metaFrom ?? `${STAGING}meta/`, d);
    await restoreDirectoryFromR2(o.warmFrom ?? `${STAGING}warm/`, d);
    await restoreDirectoryFromR2(`${STAGING}term_index/`, path.join(d, 'term_index'));
}
const dest = (env: any) => path.join(env.root, 'dest', 'output', 'data');
afterEach(() => { delete (globalThis as any).__R2_CLIENT; for (const d of tmpRoots.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });
describe('A. hermetic repro — two backup-dir to ONE prefix drops meta-00.db from the restore index', () => {
    it('surviving _manifest.json lists ONLY .bin; restore has NO meta-00.db; meta verify => FILE_MISSING: meta-00.db', async () => {
        const env = makeEnv('repro'); await produce(env, true);
        const sc = JSON.parse(env.store.get(`${STAGING}_manifest.json`)!.toString());
        expect([...sc.files].sort()).toEqual(['hot-shard.bin', 'id-index.bin', 'vector-core.bin']);
        expect(sc.files).not.toContain('meta-00.db');
        const d = dest(env); fs.mkdirSync(d, { recursive: true }); await restoreDirectoryFromR2(STAGING, d);
        expect(fs.existsSync(path.join(d, 'meta-00.db'))).toBe(false);
        expect(fs.existsSync(path.join(d, 'vector-core.bin'))).toBe(true);
        const v = vMeta(d, env.metaPath);
        expect(v.code).toBe(1); expect(v.stderr).toMatch(/FAIL FILE_MISSING/); expect(v.stderr).toMatch(/meta-00\.db/);
    });
});
describe('B. fixed role-prefix recovery — meta+warm+term each from its own sub-prefix; verify passes; NO cache used', () => {
    it('each role has its OWN _manifest.json; explicit per-role restore rebuilds output/data/; meta & warm verify pass', async () => {
        const env = makeEnv('fixed'); await produce(env, false);
        expect(JSON.parse(env.store.get(`${STAGING}meta/_manifest.json`)!.toString()).files).toContain('meta-00.db');
        expect(JSON.parse(env.store.get(`${STAGING}warm/_manifest.json`)!.toString()).files.sort()).toEqual(['hot-shard.bin', 'id-index.bin', 'vector-core.bin']);
        expect(env.store.has(`${STAGING}term_index/_manifest.json`)).toBe(true);
        const d = dest(env); expect(fs.existsSync(d)).toBe(false); // no GHA cache seeded it
        await recoverByRole(env, d);
        expect(fs.existsSync(path.join(d, 'meta-00.db'))).toBe(true);
        expect(fs.existsSync(path.join(d, 'term_index', 'aa', 'aa_0.json.zst'))).toBe(true);
        const vm = vMeta(d, env.metaPath); expect(vm.code).toBe(0); expect(vm.stdout).toBe(env.metaSetSha);
        const vw = vWarm(d, env.warmPath); expect(vw.code).toBe(0); expect(vw.stdout).toBe(env.warmSetSha);
    });
    it('preserves the D-245 descriptor identity + set_sha verify semantics (sub-prefixing changes WHERE, not content/hash)', async () => {
        const a = makeEnv('pres-a'); const b = makeEnv('pres-b');
        expect(a.metaSetSha).toBe(b.metaSetSha); expect(a.warmSetSha).toBe(b.warmSetSha);
        expect(b.descriptor.set_sha256).toBe(b.metaSetSha);
        const dv = runMjs(['verify-descriptor', b.descPath, '--carrier=vfs-pack-authority'], DPROV);
        expect(dv.code).toBe(0); expect(dv.stdout).toBe(`${STAGING}\t${b.metaSetSha}`);
        await produce(b, false); const d = dest(b); await recoverByRole(b, d);
        const vm = vMeta(d, b.metaPath); expect(vm.code).toBe(0); expect(vm.stdout).toBe(b.descriptor.set_sha256);
    });
});
describe('C. mutations — role-confusion / tamper / stale / cache-independence', () => {
    it('(1) route META restore to WARM sub-prefix => FAIL (FILE_MISSING meta-00.db)', async () => {
        const env = makeEnv('m1'); await produce(env, false); const d = dest(env);
        await recoverByRole(env, d, { metaFrom: `${STAGING}warm/` });
        const v = vMeta(d, env.metaPath); expect(v.code).toBe(1); expect(v.stderr).toMatch(/FILE_MISSING/); expect(v.stderr).toMatch(/meta-00\.db/);
    });
    it('(2) route WARM restore to META sub-prefix => FAIL (warm=the .db, no bins/term)', async () => {
        const env = makeEnv('m2'); await produce(env, false); const d = dest(env);
        await recoverByRole(env, d, { warmFrom: `${STAGING}meta/` });
        const v = vWarm(d, env.warmPath); expect(v.code).toBe(1); expect(v.stderr).toMatch(/FILE_MISSING/);
    });
    it('(3) remove meta-00.db from the meta role => FAIL (FILE_MISSING)', async () => {
        const env = makeEnv('m3'); await produce(env, false); const d = dest(env);
        await recoverByRole(env, d); fs.rmSync(path.join(d, 'meta-00.db'));
        const v = vMeta(d, env.metaPath); expect(v.code).toBe(1); expect(v.stderr).toMatch(/FILE_MISSING/);
    });
    it('(4) remove the meta CONTENT manifest while warm remains => FAIL (meta gate cannot fetch its manifest)', async () => {
        const env = makeEnv('m4'); await produce(env, false); env.store.delete(`${STAGING}manifest.json`);
        const gm = await restoreFileFromR2(`${STAGING}manifest.json`, path.join(env.root, 'm.json'));
        const gw = await restoreFileFromR2(`${STAGING}warm-read-manifest.json`, path.join(env.root, 'w.json'));
        expect(gm.success).toBe(false); expect(gw.success).toBe(true);
    });
    it('(5) stale descriptor from a PRIOR run => FAIL (DESC_RUN_MISMATCH)', async () => {
        const env = makeEnv('m5');
        const stale = { ...env.descriptor, factory_run_id: 'R0', exact_staging_prefix: `state/_handoff/vfs-pack/${UP}/R0/attempt-${ATT}/` };
        const p = path.join(env.root, 'stale.json'); fs.writeFileSync(p, JSON.stringify(stale));
        const v = runMjs(['verify-descriptor', p, '--carrier=vfs-pack-authority'], DPROV);
        expect(v.code).toBe(1); expect(v.stderr).toMatch(/DESC_RUN_MISMATCH/);
    });
    it('(6) alter the set hash => FAIL (SET_HASH_MISMATCH)', async () => {
        const env = makeEnv('m6'); await produce(env, false); const d = dest(env); await recoverByRole(env, d);
        const t = JSON.parse(fs.readFileSync(env.metaPath, 'utf8')); t.set_sha256 = 'f'.repeat(64);
        const p = path.join(env.root, 'tamper.json'); fs.writeFileSync(p, JSON.stringify(t));
        const v = vMeta(d, p); expect(v.code).toBe(1); expect(v.stderr).toMatch(/SET_HASH_MISMATCH/);
    });
    it('(7) two backup-dir target the SAME prefix (revert to the bug) => FAIL (FILE_MISSING)', async () => {
        const env = makeEnv('m7'); await produce(env, true); const d = dest(env); fs.mkdirSync(d, { recursive: true });
        await restoreDirectoryFromR2(STAGING, d);
        const v = vMeta(d, env.metaPath); expect(v.code).toBe(1); expect(v.stderr).toMatch(/FILE_MISSING/);
    });
    it('(8) remove the R2 restore path and rely ONLY on cache => FAIL (cache empty => FILE_MISSING)', async () => {
        const env = makeEnv('m8'); await produce(env, false); const d = dest(env); fs.mkdirSync(d, { recursive: true });
        expect(fs.readdirSync(d).length).toBe(0); // cache write-denied on producer run => empty; NO R2 restore done
        const v = vMeta(d, env.metaPath); expect(v.code).toBe(1); expect(v.stderr).toMatch(/FILE_MISSING/);
    });
    it('(9) GHA cache MISS with COMPLETE R2 staging => PASS (miss forces the exact R2 restore)', async () => {
        const env = makeEnv('m9'); await produce(env, false); const d = dest(env);
        expect(fs.existsSync(d)).toBe(false); await recoverByRole(env, d);
        expect(vMeta(d, env.metaPath).code).toBe(0); expect(vWarm(d, env.warmPath).code).toBe(0);
        expect(vMeta(d, env.metaPath).stdout).toBe(env.descriptor.set_sha256);
    });
    it('(10) GHA cache SAVE DENIED with COMPLETE R2 staging => PASS (denial forces the exact R2 restore)', async () => {
        const env = makeEnv('m10'); await produce(env, false); const d = dest(env);
        expect(fs.existsSync(d)).toBe(false); await recoverByRole(env, d); // recovers WITHOUT any cache data
        expect(vMeta(d, env.metaPath).code).toBe(0); expect(vWarm(d, env.warmPath).code).toBe(0);
        expect(vMeta(d, env.metaPath).stdout).toBe(env.metaSetSha);
    });
});
// D + E: parse the ACTUAL factory-upload.yml; the same invariants must RED on a reverted yml.
const YML = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/factory-upload.yml'), 'utf8').replace(/\r\n/g, '\n');
function jobBlock(name: string): string {
    const s = YML.indexOf(`\n  ${name}:`); if (s < 0) return '';
    const rest = YML.slice(s + 1); const nx = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return nx < 0 ? rest : rest.slice(0, nx);
}
const PACK = jobBlock('vfs-pack-db'); const DERIVED = jobBlock('vfs-derived');
function targets(pack: string) { return [...pack.matchAll(/backup-dir\s+\S+\s+"(\$\{STAGING\}[^"]*)"/g)].map((m) => m[1]); }
function assertNoShared(pack: string): string[] {
    const t = targets(pack);
    if (t.length < 3) throw new Error(`want>=3 targets, saw ${t.length}`);
    if (t.some((x) => x === '${STAGING}')) throw new Error('bare ${STAGING} collision');
    if (new Set(t).size !== t.length) throw new Error(`dup prefix: ${t.join(',')}`);
    return t;
}
function assertRoleRestores(pack: string, derived: string) {
    for (const r of ['meta/', 'warm/', 'term_index/']) {
        if (!pack.includes(`"\${STAGING}${r}"`)) throw new Error(`role not produced: ${r}`);
        if (!derived.includes(`restore-dir "\${STAGING_PREFIX}${r}"`)) throw new Error(`role not restored: ${r}`);
    }
}
function assertR2NotBypassable(derived: string) {
    if (!/restore-dir "\$\{STAGING_PREFIX\}meta\/" output\/data\/ --strict/.test(derived)) throw new Error('R2 meta role-prefix restore path absent');
    if (!/restore-dir "\$\{STAGING_PREFIX\}warm\/" output\/data\/ --strict/.test(derived)) throw new Error('R2 warm role-prefix restore path absent');
    if (!/NEED_RECOVER/.test(derived)) throw new Error('R2 restore not gated by verify-or-recover');
}
describe('D. workflow invariant — the actual factory-upload.yml', () => {
    it('no two vfs-pack backup-dir target the same manifest-bearing prefix (meta/warm/term_index distinct)', () => {
        expect(assertNoShared(PACK)).toEqual(expect.arrayContaining(['${STAGING}meta/', '${STAGING}warm/', '${STAGING}term_index/']));
    });
    it('every produced role has an explicit restore from its matching role sub-prefix', () => { expect(() => assertRoleRestores(PACK, DERIVED)).not.toThrow(); });
    it('the R2 role-prefix restore path is structurally present, not bypassable by a stale GHA-cache assumption', () => { expect(() => assertR2NotBypassable(DERIVED)).not.toThrow(); });
});
describe('E. anti-vacuity — the invariants go RED on a reverted workflow', () => {
    it('reverting the role-prefix fix (meta/warm -> bare ${STAGING}) reds INVARIANT 1', () => {
        const rev = PACK.replace('"${STAGING}meta/" --extensions=.db', '"${STAGING}" --extensions=.db').replace('"${STAGING}warm/" --extensions=.bin', '"${STAGING}" --extensions=.bin');
        expect(() => assertNoShared(rev)).toThrow(/bare \$\{STAGING\}|dup/);
    });
    it('removing the meta restore step reds INVARIANT 2', () => {
        expect(() => assertRoleRestores(PACK, DERIVED.replace(/^.*restore-dir "\$\{STAGING_PREFIX\}meta\/".*$/m, ''))).toThrow(/meta\//);
    });
    it('removing the warm restore step reds INVARIANT 2', () => {
        expect(() => assertRoleRestores(PACK, DERIVED.replace(/^.*restore-dir "\$\{STAGING_PREFIX\}warm\/".*$/m, ''))).toThrow(/warm\//);
    });
    it('changing the meta restore to the warm prefix reds INVARIANT 2', () => {
        expect(() => assertRoleRestores(PACK, DERIVED.replace('restore-dir "${STAGING_PREFIX}meta/"', 'restore-dir "${STAGING_PREFIX}warm/"'))).toThrow(/meta\//);
    });
    it('making cache-only recovery appear sufficient (dropping the R2 role restores) reds INVARIANT 3', () => {
        const rev = DERIVED.replace(/^.*restore-dir "\$\{STAGING_PREFIX\}meta\/".*$/m, '').replace(/^.*restore-dir "\$\{STAGING_PREFIX\}warm\/".*$/m, '');
        expect(() => assertR2NotBypassable(rev)).toThrow(/R2 (meta|warm) role-prefix restore path absent/);
    });
});
