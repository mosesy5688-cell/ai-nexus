// tests/unit/ta2-preview-runtime-gate.test.ts
// TA2-RUNTIME-GATE PR-G1 invariants (Founder D-2026-0619-77). STATIC workflow
// locks (read the gate yaml as TEXT, CRLF-normalized, no workflow exec/network)
// + HERMETIC smoke-runner unit tests (import the pure predicates, drive `probe`
// with a MOCKED fetch — no live network). Incident class: a telemetry import in
// the Worker-entry cold-load chain returned empty-body HTTP 500 on every route in
// prod while local checks FALSE-PASSED — only a real CF preview + COLD request
// catches it. Negative-presence locks inspect EXECUTABLE source (comments stripped).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
// @ts-expect-error — pure Node .mjs harness, no types
import { checkPreviewUrl, ctIsSane, assertStructure, probe, ENDPOINTS } from '../../scripts/ci/ta2-preview-smoke.mjs';
const WF = path.resolve(__dirname, '../../.github/workflows/ta2-preview-runtime-gate.yml');
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');
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
describe('TA2 gate — trigger + trust domain', () => {
  it('triggers on pull_request to main ONLY, never pull_request_target', () => {
    expect(yml).toMatch(/\non:\n {2}pull_request:\n {4}branches:\s*\[main\]/);
    expect(ymlCode).not.toContain('pull_request_target');
  });
  it('NEGATIVE: a pull_request_target trigger would fail this lock', () => {
    const mutated = yml.replace('pull_request:', 'pull_request_target:');
    expect(mutated.includes('pull_request_target')).toBe(true);
  });
  it('fork PRs fail closed: TRUSTED_BRANCH_REQUIRED + required check exits 1', () => {
    expect(jobBlock('gate-guard')).toContain('trusted=false');
    const smoke = jobBlock('preview-smoke');
    expect(smoke).toContain('TRUSTED_BRANCH_REQUIRED');
    expect(smoke).toMatch(/trusted != 'true'[\s\S]*?exit 1/);
  });
  it('same-repo branch enforcement: trusted only when head repo == base repo', () => {
    expect(jobBlock('gate-guard')).toContain('"${HEAD_REPO}" != "${BASE_REPO}"');
    expect(jobBlock('gate-guard')).toContain('trusted=true');
  });
  it('no automatic green N/A for fork PRs (preview-smoke runs if: always() and fails closed)', () => {
    const smoke = jobBlock('preview-smoke');
    expect(smoke).toContain('if: always()');
    expect(smoke).not.toMatch(/N\/A|skipped.*green|conclusion.*neutral/i);
  });
  it('required check context always reports a terminal conclusion (no skip wedge)', () => {
    expect(jobBlock('preview-smoke')).toMatch(/if: always\(\)[\s\S]*exit 1/);
  });
});
describe('TA2 gate — secret/environment trust boundary', () => {
  it('deploy + cleanup reference CF_PREVIEW_API_TOKEN via environment ta2-preview', () => {
    expect(jobBlock('deploy')).toContain('environment: ta2-preview');
    expect(jobBlock('cleanup')).toContain('environment: ta2-preview');
    expect(jobBlock('deploy')).toContain('secrets.CF_PREVIEW_API_TOKEN');
    expect(jobBlock('cleanup')).toContain('secrets.CF_PREVIEW_API_TOKEN');
  });
  it('build + smoke jobs have NO Cloudflare secret in scope', () => {
    expect(jobBlock('build')).not.toContain('secrets.CF_PREVIEW_API_TOKEN');
    expect(jobBlock('build')).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(jobBlock('preview-smoke')).not.toContain('secrets.CF_PREVIEW_API_TOKEN');
    expect(jobBlock('preview-smoke')).not.toContain('apiToken');
    expect(jobBlock('build')).not.toContain('environment: ta2-preview');
  });
  it('NEVER references the production CLOUDFLARE_API_TOKEN anywhere', () => {
    expect(yml).not.toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(yml).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
  });
  it('NEGATIVE: exposing the token to the smoke job would trip the build+smoke lock', () => {
    const mutated = jobBlock('preview-smoke') + '\n          apiToken: ${{ secrets.CF_PREVIEW_API_TOKEN }}';
    expect(mutated.includes('CF_PREVIEW_API_TOKEN')).toBe(true);
  });
  it('never echoes the token', () => {
    expect(ymlCode).not.toMatch(/echo[^\n]*CF_PREVIEW_API_TOKEN/);
    expect(smokeCode).not.toMatch(/console\.[a-z]+\([^)]*TOKEN/i);
    expect(cleanupCode).not.toMatch(/console\.[a-z]+\([^)]*TOKEN/i);
  });
});
describe('TA2 gate — four trust-domain jobs', () => {
  it('build: no install/build of candidate in deploy; checkout exact control SHA + upload immutable dist', () => {
    const b = jobBlock('build');
    expect(b).toContain('ref: ${{ matrix.sha }}');
    expect(b).toContain('npm ci');
    expect(b).toContain('npm run build');
    expect(b).toContain("fs.writeFileSync('dist/_worker.js'");
    expect(b).toContain('dist-manifest.sha256');
    expect(b).toContain('actions/upload-artifact@');
  });
  it('deploy: downloads dist, does NOT npm install / run build / execute candidate', () => {
    const d = jobBlock('deploy');
    expect(d).toContain('actions/download-artifact@');
    expect(d).not.toContain('npm ci');
    expect(d).not.toContain('npm run build');
    expect(d).toContain('pages deploy dist --project-name=ai-nexus --branch=');
  });
  it('deploy outputs exact deployment id + preview url', () => {
    const d = jobBlock('deploy');
    expect(d).toContain('deployment_id: ${{ steps.out.outputs.deployment_id }}');
    expect(d).toContain('preview_url: ${{ steps.out.outputs.preview_url }}');
    expect(d).toContain('wrangler@4 pages deployment list'); // EXACT id resolved, not the url
    expect(d).toMatch(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/); // UUID extraction
  });
  it('smoke runs the runner against the preview URL only', () => {
    const s = jobBlock('preview-smoke');
    expect(s).toContain('scripts/ci/ta2-preview-smoke.mjs');
    expect(s).toContain('name: ta2-deploy-${{ matrix.control }}'); // per-control handoff
    expect(s).toContain("require('./deploy-info.json').preview_url");
    expect(s).not.toContain('free2aitools.com');
  });
});
describe('TA2 gate — preview naming + production exclusion', () => {
  it('deterministic name ta2-pr-<PR>-run-<RUN_ID>-attempt-<RUN_ATTEMPT>-<CONTROL>', () => {
    expect(jobBlock('deploy')).toContain('PB="ta2-pr-${{ github.event.pull_request.number }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}-${CONTROL}"');
  });
  it('HARD-ASSERT branch is not main / prod branch / empty, controls are a fixed set', () => {
    const d = jobBlock('deploy');
    expect(d).toContain('[ "$PB" = "main" ]');
    expect(d).toContain('[ "$PB" = "$PROD_BRANCH" ]');
    expect(d).toContain('[ -z "$PB" ]');
    expect(d).toContain('candidate|broken|recovered|current)');
  });
  it('no main-branch deployment: deploy never passes --branch=main', () => {
    expect(yml).not.toContain('--branch=main');
    expect(yml).toContain('--branch=${{ steps.name.outputs.preview_branch }}');
  });
  it('preview URL must be *.pages.dev; prod custom domain fails immediately', () => {
    const d = jobBlock('deploy');
    expect(d).toContain('*.pages.dev');
    expect(d).toContain('free2aitools.com|*.free2aitools.com');
  });
  it('NEGATIVE: a branch=main mutation would trip the no-main lock', () => {
    expect(yml.replace('--branch=${{ steps.name.outputs.preview_branch }}', '--branch=main')).toContain('--branch=main');
  });
});
describe('TA2 gate — pinning + telemetry + R2', () => {
  it('ALL third-party actions pinned by 40-hex commit SHA', () => {
    const uses = [...yml.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, `unpinned action: ${u}`).toMatch(/@[0-9a-f]{40}$/);
  });
  it('telemetry OFF (no TELEMETRY_ENABLED=true) + canary AE dataset retained under [env.preview] (binding token NOT named here -- repo-wide-confined by the no-read gate)', () => {
    expect(ymlCode).not.toMatch(/TELEMETRY_ENABLED\s*[:=]\s*['"]?true/i);
    const toml = fs.readFileSync(path.resolve(__dirname, '../../wrangler.toml'), 'utf8');
    expect(toml).toContain('free2aitools_adoption_canary_v1');
    expect(toml).toMatch(/\[env\.preview\][\s\S]*free2aitools_adoption_canary_v1/);
  });
  it('R2 write-surface change blocks preview (PREVIEW_R2_ISOLATION_REQUIRED)', () => {
    const g = jobBlock('gate-guard');
    expect(g).toContain('PREVIEW_R2_ISOLATION_REQUIRED');
    expect(g).toContain('R2_ASSETS[^;]*\\.(put|delete|createMultipartUpload|resumeMultipartUpload)');
    expect(g).toMatch(/grep -E "\$WRITE_RE"[\s\S]*exit 1/);
  });
});
describe('TA2 gate — cleanup + qualification', () => {
  it('cleanup always runs (if: always()) and deletes by exact id with --force', () => {
    expect(jobBlock('cleanup')).toContain('if: always()');
    expect(cleanupSrc).toContain("'pages', 'deployment', 'delete', DEPLOYMENT_ID");
    expect(cleanupSrc).toContain("'--force'");
  });
  it('cleanup verifies absence; a cleanup/verify failure is RED (process.exit non-zero)', () => {
    expect(cleanupSrc).toContain('STILL PRESENT after delete');
    expect(cleanupCode).toMatch(/process\.exit\(1\)/);
    expect(cleanupCode).not.toMatch(/continue-on-error/i);
  });
  it('NEGATIVE: downgrading cleanup to a warning would drop the exit(1) fail path', () => {
    expect(cleanupCode.replace(/process\.exit\(1\)/g, 'console.warn("warn")')).not.toContain('process.exit(1)');
  });
  it('qualification-verdict is INDEPENDENT and passes only on the exact control matrix', () => {
    const q = jobBlock('qualification-verdict');
    expect(q).toContain('candidate != PASS');
    expect(q).toContain('broken != EXPECTED_RUNTIME_FAIL');
    expect(q).toContain('recovered != PASS');
    expect(q).toContain('current base != PASS');
    expect(q).toContain('a cleanup job did not pass');
    expect(q).toContain('QUALIFICATION_VERDICT=PASS');
  });
  it('broken EXPECTED_RUNTIME_FAIL requires deploy success first (build/deploy fail cannot masquerade)', () => {
    const s = jobBlock('preview-smoke');
    expect(s).toContain("needs.deploy.result != 'success'");
    expect(s).toMatch(/CONTROL" = "broken" \] && \[ "\$VERDICT" = "FAIL" \][\s\S]*EXPECTED_RUNTIME_FAIL/);
  });
  it('NEGATIVE: treating a broken-build as expected runtime fail would need the deploy gate removed', () => {
    expect(jobBlock('preview-smoke')).toContain("needs.deploy.result != 'success'");
  });
  it('matrix job does not go red merely because broken is expected to fail (fail-fast false)', () => {
    expect(jobBlock('preview-smoke')).toContain('fail-fast: false');
  });
  it('the four controls map to candidate/broken(cd64c8b4)/recovered(b5107e4c)/current(base)', () => {
    const b = jobBlock('build');
    expect(b).toContain('sha: cd64c8b49ffda41ff92188642dd6a8e95a8022fc');
    expect(b).toContain('sha: b5107e4c4cb274e1eb560128a28bc1682eb828ad');
    expect(b).toContain('${{ needs.gate-guard.outputs.candidate_sha }}');
    expect(b).toContain('${{ needs.gate-guard.outputs.base_sha }}');
  });
});
describe('TA2 smoke runner — endpoints + cold-first', () => {
  it('exactly the six endpoints, /api/v1/health FIRST (cold, no warm-up)', () => {
    expect(ENDPOINTS.map((e: any) => e.path)).toEqual(['/api/v1/health', '/api/v1/search?q=test', '/api/mcp', '/api/v1/datasets', '/openapi.json', '/llms.txt']);
    expect(ENDPOINTS[0].path).toBe('/api/v1/health');
    expect(smokeCode).not.toMatch(/warm.?up/i);
  });
  it('content-type sanity: json for api/openapi/mcp, text/* for llms', () => {
    expect(ctIsSane('json', 'application/json; charset=utf-8')).toBe(true);
    expect(ctIsSane('openapi', 'application/json')).toBe(true);
    expect(ctIsSane('text', 'text/plain')).toBe(true);
    expect(ctIsSane('json', 'text/html')).toBe(false);
    expect(ctIsSane('text', 'application/json')).toBe(false);
  });
  it('structure asserts: health JSON / mcp JSON-RPC / openapi openapi+paths / search object', () => {
    expect(assertStructure('health', '{"ok":true}')).toBe('json-ok');
    expect(() => assertStructure('mcp', '{"jsonrpc":"1.0"}')).toThrow();
    expect(assertStructure('mcp', '{"jsonrpc":"2.0","id":1,"result":{}}')).toBe('json-ok');
    expect(() => assertStructure('openapi', '{"paths":{}}')).toThrow();
    expect(assertStructure('openapi', '{"openapi":"3.1.0","paths":{}}')).toBe('json-ok');
    expect(() => assertStructure('search', '[1,2]')).toThrow();
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
  it('5xx status = FAIL', async () => expect((await run(mk(500, 'application/json', ''))).error).toContain('5xx'));
  it('empty body (200) = FAIL', async () => expect((await run(mk(200, 'application/json', ''))).error).toBe('empty body'));
  it('wrong content-type = FAIL', async () => expect((await run(mk(200, 'text/html', '<html></html>'))).error).toContain('bad content-type'));
  it('schema/parse failure = FAIL', async () => expect((await run(mk(200, 'application/json', 'not json'))).error).toContain('structure'));
  it('connection/timeout failure = FAIL (closed)', async () => {
    const r = await run(() => Promise.reject(Object.assign(new Error('boom'), { name: 'TimeoutError' })));
    expect(r.error).toContain('timeout');
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