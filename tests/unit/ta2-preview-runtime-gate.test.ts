// tests/unit/ta2-preview-runtime-gate.test.ts
// TA2-RUNTIME-GATE PR-G1 invariants (D-2026-0619-77) + TA2-GATE-PROVENANCE-1 EXACT
// built-commit identity binding (D-2026-0620-78). STATIC workflow locks (gate yaml
// as TEXT, CRLF-normalized, no exec/network) + HERMETIC smoke/verdict EXEC tests
// (pure predicates, MOCKED fetch + temp-dir fixtures). Negative-presence locks
// inspect EXECUTABLE source. Incident: a telemetry import in the Worker-entry cold-
// load chain 500'd every route in prod while local checks FALSE-PASSED.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
// @ts-expect-error — pure Node .mjs harness, no types
import { checkPreviewUrl, ctIsSane, assertStructure, probe, ENDPOINTS, checkBuildIdentity } from '../../scripts/ci/ta2-preview-smoke.mjs';
// @ts-expect-error — pure Node .mjs harness, no types
import { verifyIdentityChain, defaultIdentityTree, writeIdentityTree } from '../../scripts/ci/ta2-preview-cleanup.mjs';
const yml = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ta2-preview-runtime-gate.yml'), 'utf8').replace(/\r\n/g, '\n');
const smokeSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/ci/ta2-preview-smoke.mjs'), 'utf8');
const cleanupSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/ci/ta2-preview-cleanup.mjs'), 'utf8');
function jobBlock(name: string): string {
  const start = yml.indexOf(`\n  ${name}:`);
  if (start < 0) return '';
  const rest = yml.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}
const stripC = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const ymlCode = stripC(yml);
const smokeCode = stripC(smokeSrc.replace(/\/\/[^\n]*/g, ''));
const cleanupCode = stripC(cleanupSrc.replace(/\/\/[^\n]*/g, ''));
const has = (block: string, ...needles: string[]) => { for (const n of needles) expect(block, n).toContain(n); };
describe('TA2 gate — trigger + trust domain', () => {
  it('triggers on pull_request to main ONLY, never pull_request_target', () => {
    expect(yml).toMatch(/\non:\n {2}pull_request:\n {4}branches:\s*\[main\]/);
    expect(ymlCode).not.toContain('pull_request_target');
  });
  it('NEGATIVE: a pull_request_target trigger would fail this lock', () =>
    expect(yml.replace('pull_request:', 'pull_request_target:').includes('pull_request_target')).toBe(true));
  it('fork fail-closed (TRUSTED_BRANCH_REQUIRED + exit 1); same-repo enforcement; no green N/A skip wedge', () => {
    has(jobBlock('gate-guard'), 'trusted=false', '"${HEAD_REPO}" != "${BASE_REPO}"', 'trusted=true');
    has(jobBlock('preview-smoke'), 'TRUSTED_BRANCH_REQUIRED', 'if: always()');
    expect(jobBlock('preview-smoke')).toMatch(/trusted != 'true'[\s\S]*?exit 1/);
    expect(jobBlock('preview-smoke')).not.toMatch(/N\/A|skipped.*green|conclusion.*neutral/i);
    expect(jobBlock('preview-smoke')).toMatch(/if: always\(\)[\s\S]*exit 1/);
  });
});
describe('TA2 gate — secret/environment trust boundary', () => {
  it('deploy + cleanup hold CF_PREVIEW_API_TOKEN via Environment ta2-preview', () => {
    for (const j of ['deploy', 'cleanup']) has(jobBlock(j), 'environment: ta2-preview', 'secrets.CF_PREVIEW_API_TOKEN');
  });
  it('build + smoke jobs have NO Cloudflare secret in scope', () => {
    for (const t of ['secrets.CF_PREVIEW_API_TOKEN', 'CLOUDFLARE_API_TOKEN', 'environment: ta2-preview']) expect(jobBlock('build')).not.toContain(t);
    for (const t of ['secrets.CF_PREVIEW_API_TOKEN', 'apiToken']) expect(jobBlock('preview-smoke')).not.toContain(t);
  });
  it('NEVER references the production CLOUDFLARE_API_TOKEN; never echoes the token', () => {
    expect(yml).not.toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(yml).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(ymlCode).not.toMatch(/echo[^\n]*CF_PREVIEW_API_TOKEN/);
    expect(smokeCode).not.toMatch(/console\.[a-z]+\([^)]*TOKEN/i);
    expect(cleanupCode).not.toMatch(/console\.[a-z]+\([^)]*TOKEN/i);
  });
  it('NEGATIVE: exposing the token to the smoke job would trip the build+smoke lock', () =>
    expect((jobBlock('preview-smoke') + '\n          apiToken: ${{ secrets.CF_PREVIEW_API_TOKEN }}').includes('CF_PREVIEW_API_TOKEN')).toBe(true));
});
describe('TA2 gate — four trust-domain jobs', () => {
  it('build: checkout exact control SHA, mirror infra-deploy build+restructure, upload immutable dist', () =>
    has(jobBlock('build'), 'ref: ${{ matrix.sha }}', 'npm ci', 'npm run build', "fs.writeFileSync('dist/_worker.js'", 'dist-manifest.sha256', 'actions/upload-artifact@'));
  it('deploy: downloads dist, does NOT npm install / run build / execute candidate', () => {
    expect(jobBlock('deploy')).toContain('actions/download-artifact@');
    for (const t of ['npm ci', 'npm run build']) expect(jobBlock('deploy')).not.toContain(t);
    expect(jobBlock('deploy')).toContain('pages deploy dist --project-name=ai-nexus --branch=');
  });
  it('deploy outputs exact deployment id + preview url (UUID resolved, not the url)', () => {
    has(jobBlock('deploy'), 'deployment_id: ${{ steps.out.outputs.deployment_id }}', 'preview_url: ${{ steps.out.outputs.preview_url }}', 'wrangler@4 pages deployment list');
    expect(jobBlock('deploy')).toMatch(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
  });
  it('smoke runs the runner against the preview URL only (per-control handoff)', () => {
    has(jobBlock('preview-smoke'), 'scripts/ci/ta2-preview-smoke.mjs', 'name: ta2-deploy-${{ matrix.control }}', "require('./deploy-info.json').preview_url");
    expect(jobBlock('preview-smoke')).not.toContain('free2aitools.com');
  });
});
describe('TA2 gate — preview naming + production exclusion', () => {
  it('deterministic name ta2-pr-<PR>-run-<RUN_ID>-attempt-<RUN_ATTEMPT>-<CONTROL>', () =>
    expect(jobBlock('deploy')).toContain('PB="ta2-pr-${{ github.event.pull_request.number }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}-${CONTROL}"'));
  it('HARD-ASSERT branch not main / prod / empty; controls a fixed set; URL must be *.pages.dev', () =>
    has(jobBlock('deploy'), '[ "$PB" = "main" ]', '[ "$PB" = "$PROD_BRANCH" ]', '[ -z "$PB" ]', 'candidate|broken|recovered|current)', '*.pages.dev', 'free2aitools.com|*.free2aitools.com'));
  it('no main-branch deployment (NEGATIVE: a branch=main mutation trips the no-main lock)', () => {
    expect(yml).not.toContain('--branch=main');
    expect(yml).toContain('--branch=${{ steps.name.outputs.preview_branch }}');
    expect(yml.replace('--branch=${{ steps.name.outputs.preview_branch }}', '--branch=main')).toContain('--branch=main');
  });
});
describe('TA2 gate — pinning + telemetry + R2', () => {
  it('ALL third-party actions pinned by 40-hex commit SHA', () => {
    const uses = [...yml.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, `unpinned action: ${u}`).toMatch(/@[0-9a-f]{40}$/);
  });
  it('telemetry OFF (no TELEMETRY_ENABLED=true) + canary AE dataset retained under [env.preview]', () => {
    expect(ymlCode).not.toMatch(/TELEMETRY_ENABLED\s*[:=]\s*['"]?true/i);
    const toml = fs.readFileSync(path.resolve(__dirname, '../../wrangler.toml'), 'utf8');
    expect(toml).toContain('free2aitools_adoption_canary_v1');
    expect(toml).toMatch(/\[env\.preview\][\s\S]*free2aitools_adoption_canary_v1/);
  });
  it('R2 write-surface change blocks preview (PREVIEW_R2_ISOLATION_REQUIRED)', () => {
    has(jobBlock('gate-guard'), 'PREVIEW_R2_ISOLATION_REQUIRED', 'R2_ASSETS[^;]*\\.(put|delete|createMultipartUpload|resumeMultipartUpload)');
    expect(jobBlock('gate-guard')).toMatch(/grep -E "\$WRITE_RE"[\s\S]*exit 1/);
  });
});
describe('TA2 gate — cleanup + qualification', () => {
  it('cleanup always runs (if: always()) and deletes by exact id with --force', () => {
    expect(jobBlock('cleanup')).toContain('if: always()');
    has(cleanupSrc, "'pages', 'deployment', 'delete', DEPLOYMENT_ID", "'--force'");
  });
  it('cleanup verifies absence; a cleanup/verify failure is RED (process.exit non-zero, no warning-only)', () => {
    expect(cleanupSrc).toContain('STILL PRESENT after delete');
    expect(cleanupCode).toMatch(/process\.exit\(1\)/);
    expect(cleanupCode).not.toMatch(/continue-on-error/i);
    expect(cleanupCode.replace(/process\.exit\(1\)/g, 'console.warn("warn")')).not.toContain('process.exit(1)');
  });
  it('qualification-verdict is INDEPENDENT and passes only on the exact control matrix', () =>
    has(jobBlock('qualification-verdict'), 'candidate != PASS', 'broken != EXPECTED_RUNTIME_FAIL', 'recovered != PASS', 'current base != PASS', 'a cleanup job did not pass', 'QUALIFICATION_VERDICT=PASS'));
  it('broken EXPECTED_RUNTIME_FAIL requires deploy success first; matrix fail-fast false', () => {
    has(jobBlock('preview-smoke'), "needs.deploy.result != 'success'", 'fail-fast: false');
    expect(jobBlock('preview-smoke')).toMatch(/CONTROL" = "broken" \] && \[ "\$VERDICT" = "FAIL" \][\s\S]*EXPECTED_RUNTIME_FAIL/);
  });
  it('the four controls map to candidate/broken(cd64c8b4)/recovered(b5107e4c)/current(base)', () =>
    has(jobBlock('build'), 'sha: cd64c8b49ffda41ff92188642dd6a8e95a8022fc', 'sha: b5107e4c4cb274e1eb560128a28bc1682eb828ad', '${{ needs.gate-guard.outputs.candidate_sha }}', '${{ needs.gate-guard.outputs.base_sha }}'));
});
describe('TA2 smoke runner — endpoints + cold-first', () => {
  it('exactly the six endpoints, /api/v1/health FIRST (cold, no warm-up)', () => {
    expect(ENDPOINTS.map((e: any) => e.path)).toEqual(['/api/v1/health', '/api/v1/search?q=test', '/api/mcp', '/api/v1/datasets', '/openapi.json', '/llms.txt']);
    expect(smokeCode).not.toMatch(/warm.?up/i);
  });
  it('content-type sanity: json for api/openapi/mcp, text/* for llms', () => {
    for (const [k, ct] of [['json', 'application/json; charset=utf-8'], ['openapi', 'application/json'], ['text', 'text/plain']] as any) expect(ctIsSane(k, ct)).toBe(true);
    expect(ctIsSane('json', 'text/html')).toBe(false);
    expect(ctIsSane('text', 'application/json')).toBe(false);
  });
  it('structure asserts: health JSON / mcp JSON-RPC / openapi openapi+paths / search object', () => {
    expect(assertStructure('health', '{"ok":true}')).toBe('json-ok');
    expect(assertStructure('mcp', '{"jsonrpc":"2.0","id":1,"result":{}}')).toBe('json-ok');
    expect(assertStructure('openapi', '{"openapi":"3.1.0","paths":{}}')).toBe('json-ok');
    for (const [k, b] of [['mcp', '{"jsonrpc":"1.0"}'], ['openapi', '{"paths":{}}'], ['search', '[1,2]']] as any) expect(() => assertStructure(k, b)).toThrow();
  });
  it('production-exclusion: prod custom domain + non-pages.dev hosts are rejected', () => {
    for (const u of ['https://free2aitools.com', 'https://x.free2aitools.com', 'http://abc.ai-nexus.pages.dev', 'https://evil.example.com']) expect(() => checkPreviewUrl(u)).toThrow();
    expect(checkPreviewUrl('https://abc.ai-nexus.pages.dev').hostname).toContain('pages.dev');
  });
});
describe('TA2 smoke runner — fail-closed via mocked fetch', () => {
  const realFetch = globalThis.fetch; afterEach(() => { globalThis.fetch = realFetch; });
  const base = new URL('https://abc.ai-nexus.pages.dev');
  const mk = (status: number, ct: string, body: string) => () => Promise.resolve(new Response(body, { status, headers: { 'content-type': ct } }));
  const run = async (f: any) => { globalThis.fetch = f as any; return probe(base, ENDPOINTS[0]); };
  it('5xx / empty / wrong-ct / parse-fail / timeout all FAIL-CLOSED', async () => {
    expect((await run(mk(500, 'application/json', ''))).error).toContain('5xx');
    expect((await run(mk(200, 'application/json', ''))).error).toBe('empty body');
    expect((await run(mk(200, 'text/html', '<html></html>'))).error).toContain('bad content-type');
    expect((await run(mk(200, 'application/json', 'not json'))).error).toContain('structure');
    expect((await run(() => Promise.reject(Object.assign(new Error('boom'), { name: 'TimeoutError' })))).error).toContain('timeout');
  });
  it('healthy response = PASS and records ONLY status/ct/len/sha (no raw body archived)', async () => {
    globalThis.fetch = mk(200, 'application/json', '{"status":"ok"}') as any;
    const r = await probe(base, ENDPOINTS[0]);
    expect(r.error).toBeUndefined();
    expect(r.rec.status).toBe(200);
    expect(r.rec.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.rec).not.toHaveProperty('body');
    expect(JSON.stringify(r.rec)).not.toContain('"status":"ok"');
  });
});
// ===== TA2-GATE-PROVENANCE-1 (D-2026-0620-78): every artifact self-binds its EXACT
// built-commit identity; the verdict fails closed on any identity defect. =====
const EXPECT = { broken: 'cd64c8b49ffda41ff92188642dd6a8e95a8022fc', recovered: 'b5107e4c4cb274e1eb560128a28bc1682eb828ad', current: '1aaa535e5402e2a0e1a2882faf0a96bfc6ac6189', candidate: 'a'.repeat(40) };
describe('TA2 identity — BUILD emits EXACT built commit (D-78 §4)', () => {
  it('resolved_commit_sha = `git rev-parse HEAD` AFTER checkout; build FAILS if not 40-hex', () => {
    const b = jobBlock('build');
    expect(b).toContain('RESOLVED=$(git rev-parse HEAD)');
    expect(b.indexOf('Checkout EXACT control SHA')).toBeLessThan(b.indexOf('git rev-parse HEAD'));
    expect(b).toContain("grep -Eq '^[0-9a-f]{40}$'");
    expect(b).toMatch(/is not a full 40-hex SHA[\s\S]*exit 1/);
  });
  it('self-binding build-identity.json (4 fields + det. artifact hash) uploaded INSIDE dist; github.sha is NOT the identity', () => {
    const b = jobBlock('build');
    has(b, 'control', 'requested_ref', 'resolved_commit_sha', 'build_artifact_sha256', 'BUILD_ARTIFACT_SHA256=$(sha256sum dist-manifest.sha256');
    expect(b).toMatch(/name: ta2-dist-\$\{\{ matrix\.control \}\}[\s\S]*build-identity\.json/);
    expect(stripC(b)).not.toContain('github.sha');
  });
});
describe('TA2 identity — END-TO-END propagation (D-78 §5)', () => {
  it('deploy READS build-identity.json (no github.sha recompute) + forwards identity', () => {
    const d = stripC(jobBlock('deploy'));
    has(d, "require('./build-identity.json').resolved_commit_sha", 'build-identity.json missing', 'requested_ref', 'resolved_commit_sha', 'build_artifact_sha256', 'deployment_id');
    expect(d).not.toContain('github.sha');
  });
  it('CORE FIX: smoke uses the PROPAGATED resolved_commit_sha, NEVER github.sha', () => {
    const s = stripC(jobBlock('preview-smoke'));
    has(s, "require('./deploy-info.json').resolved_commit_sha", 'RESOLVED_COMMIT_SHA REQUESTED_REF BUILD_ARTIFACT_SHA256');
    expect(s).not.toContain('CANDIDATE_SHA: ${{ github.sha }}');
    expect(s).not.toContain('github.sha');
  });
  it('NEGATIVE MUTATION: re-introducing CANDIDATE_SHA=github.sha into smoke trips the lock', () =>
    expect((stripC(jobBlock('preview-smoke')) + '\n          CANDIDATE_SHA: ${{ github.sha }}')).toContain('github.sha'));
  it('cleanup records identity + deployment_id; verdict downloads all 4 records + validates chain', () => {
    has(stripC(jobBlock('cleanup')), 'CLEANUP_RESULT_PATH', 'RESOLVED_COMMIT_SHA REQUESTED_REF BUILD_ARTIFACT_SHA256 DEPLOYMENT_ID', 'name: ta2-cleanup-${{ matrix.control }}');
    has(stripC(jobBlock('qualification-verdict')), 'pattern: ta2-dist-*', 'pattern: ta2-deploy-*', 'pattern: ta2-smoke-*', 'pattern: ta2-cleanup-*', '--verify-identity-chain',
      'CANDIDATE_SHA: ${{ needs.gate-guard.outputs.candidate_sha }}', 'EXPECT_BROKEN: cd64c8b49ffda41ff92188642dd6a8e95a8022fc',
      'EXPECT_RECOVERED: b5107e4c4cb274e1eb560128a28bc1682eb828ad', 'EXPECT_CURRENT: ${{ needs.gate-guard.outputs.base_sha }}');
  });
});
describe('TA2 identity — verdict EXACT chain fail-closed (D-78 §6, EXEC, temp fixtures)', () => {
  it('smoke fail-closed: full 40-hex passes every control; abbreviated/missing/github.sha-shaped all FAIL', () => {
    for (const c of Object.values(EXPECT)) expect(checkBuildIdentity({ resolvedCommitSha: c })).toBe(c);
    for (const v of ['cd64c8b4', '', 'eec05489']) expect(() => checkBuildIdentity({ resolvedCommitSha: v })).toThrow();
    expect(() => checkBuildIdentity({})).toThrow();
  });
  const tmps: string[] = [];
  afterEach(() => { for (const t of tmps.splice(0)) try { fs.rmSync(t, { recursive: true, force: true }); } catch {} });
  // fixture() writes the default PASSING tree (defaultIdentityTree+writeIdentityTree live
  // beside verifyIdentityChain so the on-disk layout can never drift); mut() perturbs it.
  function fixture(mut?: (t: any) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta2-ident-')); tmps.push(root);
    const dirs: any = { buildsDir: path.join(root, 'b'), deploysDir: path.join(root, 'd'), verdictsDir: path.join(root, 'v'), cleanupsDir: path.join(root, 'c') };
    const expected = { candidate: EXPECT.candidate, broken: EXPECT.broken, recovered: EXPECT.recovered, current: EXPECT.current };
    const tree = defaultIdentityTree(expected);
    if (mut) mut(tree);
    writeIdentityTree(dirs, tree);
    return { ...dirs, expected };
  }
  const fails = (mut: (t: any) => void) => expect(verifyIdentityChain(fixture(mut)).ok).toBe(false);
  it('exact four-control chain PASSES', () => expect(verifyIdentityChain(fixture()).ok).toBe(true));
  it('build/deploy SHA mismatch FAILS', () => fails((t) => { t.candidate.deploy.resolved_commit_sha = 'b'.repeat(40); }));
  it('deploy/smoke SHA mismatch FAILS', () => fails((t) => { t.recovered.smoke.resolved_commit_sha = 'c'.repeat(40); }));
  it('smoke/cleanup SHA mismatch FAILS', () => fails((t) => { t.current.cleanup.resolved_commit_sha = 'd'.repeat(40); }));
  it('artifact-hash mismatch across stages FAILS', () => fails((t) => { t.candidate.smoke.build_artifact_sha256 = 'z'.repeat(64); }));
  it('abbreviated SHA in a stage FAILS', () => fails((t) => { t.broken.build.resolved_commit_sha = 'cd64c8b4'; }));
  it('missing resolved_commit_sha in a stage FAILS', () => fails((t) => { delete t.candidate.build.resolved_commit_sha; }));
  it('requested_ref without resolved_commit_sha FAILS (label alone insufficient)', () =>
    fails((t) => { t.candidate.smoke = { control: 'candidate', requested_ref: 'candidate' }; }));
  it('a missing stage record FAILS (matrix label alone cannot satisfy)', () => fails((t) => { t.broken.cleanup = null; }));
  it('wrong control-to-SHA mapping FAILS (broken built recovered`s SHA)', () =>
    fails((t) => { for (const k of Object.keys(t.broken)) t.broken[k].resolved_commit_sha = EXPECT.recovered; }));
  it('candidate built the WRONG integration SHA (not gate-guard candidate_sha) FAILS', () =>
    fails((t) => { for (const k of Object.keys(t.candidate)) t.candidate[k].resolved_commit_sha = 'e'.repeat(40); }));
  it('verdict stays FAIL-CLOSED: an expected SHA absent/non-40hex FAILS', () => {
    const fx = fixture(); (fx.expected as any).broken = 'cd64c8b4';
    expect(verifyIdentityChain(fx).ok).toBe(false);
  });
});
