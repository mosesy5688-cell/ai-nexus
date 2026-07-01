// scripts/ci/ta2-preview-readiness.test.mjs
// Hermetic node:test suite for the TA2 served-readiness + same-attempt provenance
// contract (Founder D-207 §Q minimum 40 cases + §R anti-vacuity). NO real network
// (fetch is injected), NO real sleep (the clock is injected) — every timeout /
// ceiling test is deterministic and fast. Node built-ins ONLY.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_ATTEMPTS, INTERVAL_MS, REQUEST_TIMEOUT_MS, MAX_WALL_CLOCK_MS,
  CLASSIFICATION, ARM_VERDICT, CONTROLS,
  REDEPLOY_TOKEN, FORBIDDEN_RERUN_PHRASE, operatorGuidance,
  ctIsJson, detectCloudflareNotServed, bodyFingerprint, classifyTargetHost,
  deploymentRecordArtifactName, isRunAttemptBoundArtifactName, markerRelPath,
  buildMarkerObject, serializeMarker, checkMarkerIdentity, classifyMarkerResponse,
  validateDeploymentRecord, pollReadiness, classifyBrokenArm, computeArmVerdict,
  computeQualificationVerdict,
} from './ta2-preview-readiness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = '1234567890';
const RUN_ATTEMPT = '3';
const ARM = 'candidate';
const SRC = 'a'.repeat(40);
const BUILD_HASH = 'b'.repeat(64);
const TREE_HASH = 'c'.repeat(64);

function expectedFor(over = {}) {
  return { githubRunId: RUN_ID, githubRunAttempt: RUN_ATTEMPT, arm: ARM, sourceSha: SRC, buildArtifactSha256: BUILD_HASH, ...over };
}
function markerBytesFor(over = {}) {
  const obj = buildMarkerObject({ runId: RUN_ID, runAttempt: RUN_ATTEMPT, arm: ARM, sourceSha: SRC, buildArtifactSha256: BUILD_HASH, createdAtUtc: '2026-06-30T00:00:00Z', ...over });
  return serializeMarker(obj);
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function recordFor(over = {}) {
  const marker = markerBytesFor();
  return {
    schema_version: 'ta2-deploy-record/v1', github_run_id: RUN_ID, github_run_attempt: RUN_ATTEMPT,
    arm: ARM, source_sha: SRC, build_artifact_sha256: BUILD_HASH, deploy_tree_manifest_sha256: TREE_HASH,
    marker_path: markerRelPath({ runId: RUN_ID, runAttempt: RUN_ATTEMPT, arm: ARM }), marker_sha256: sha256(marker),
    cloudflare_deployment_id: 'dep-uuid', preview_url: 'https://ta2-pr-1-run-1234567890-attempt-3-candidate.ai-nexus.pages.dev',
    deployment_timestamp_utc: '2026-06-30T00:00:01Z', deploy_exit_status: 0, ...over,
  };
}
// Injected virtual clock: now()/sleep() share one timeline; fetches may tick it.
function makeClock() { let t = 0; return { now: () => t, tick: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } }; }
// fetchMarker stub returning a fixed served 200 marker.
function servedFetch(marker) {
  return async () => ({ status: 200, contentType: 'application/json; charset=utf-8', body: marker });
}

// ----------------------- §I same-attempt record gate -----------------------
test('(1) current-attempt record accepted', () => {
  const v = validateDeploymentRecord(recordFor(), expectedFor());
  assert.equal(v.ok, true);
});
test('(2) prior-attempt record rejected (STALE + redeploy guidance, no rerun phrase)', () => {
  const v = validateDeploymentRecord(recordFor({ github_run_attempt: '2' }), expectedFor());
  assert.equal(v.ok, false);
  assert.equal(v.classification, CLASSIFICATION.STALE);
  assert.ok(v.guidance.includes(REDEPLOY_TOKEN));
  assert.ok(!v.guidance.includes(FORBIDDEN_RERUN_PHRASE));
});
test('(3) wrong run id rejected (STALE)', () => {
  const v = validateDeploymentRecord(recordFor({ github_run_id: '999' }), expectedFor());
  assert.equal(v.ok, false);
  assert.equal(v.classification, CLASSIFICATION.STALE);
});
test('(4) wrong arm rejected (EXECUTION_INVALID)', () => {
  const v = validateDeploymentRecord(recordFor({ arm: 'broken' }), expectedFor());
  assert.equal(v.ok, false);
  assert.equal(v.classification, CLASSIFICATION.EXECUTION_INVALID);
});
test('(5) wrong source sha rejected', () => {
  const v = validateDeploymentRecord(recordFor({ source_sha: 'd'.repeat(40) }), expectedFor());
  assert.equal(v.ok, false);
});
test('(6) wrong build hash rejected', () => {
  const v = validateDeploymentRecord(recordFor({ build_artifact_sha256: 'e'.repeat(64) }), expectedFor());
  assert.equal(v.ok, false);
});
test('(7) wrong deploy-tree hash rejected', () => {
  const v = validateDeploymentRecord(recordFor({ deploy_tree_manifest_sha256: 'f'.repeat(64) }), expectedFor({ deployTreeManifestSha256: TREE_HASH }));
  assert.equal(v.ok, false);
});
test('(8) wrong marker hash rejected', () => {
  const v = validateDeploymentRecord(recordFor({ marker_sha256: '0'.repeat(64) }), expectedFor({ markerSha256: sha256(markerBytesFor()) }));
  assert.equal(v.ok, false);
});
test('(9) missing record rejected (STALE)', () => {
  const v = validateDeploymentRecord(null, expectedFor());
  assert.equal(v.ok, false);
  assert.equal(v.classification, CLASSIFICATION.STALE);
});
test('(10) unversioned artifact name rejected; run-attempt-bound accepted', () => {
  const ctx = { runId: RUN_ID, runAttempt: RUN_ATTEMPT, arm: ARM };
  assert.equal(isRunAttemptBoundArtifactName('ta2-deploy-record-candidate', ctx), false);
  assert.equal(isRunAttemptBoundArtifactName(`ta2-deploy-record-${RUN_ID}-${ARM}`, ctx), false);
  assert.equal(isRunAttemptBoundArtifactName(deploymentRecordArtifactName(ctx), ctx), true);
});

// --------------------------- marker classification --------------------------
test('(11) exact marker JSON accepted (SERVED, ready)', () => {
  const marker = markerBytesFor();
  const c = classifyMarkerResponse({ status: 200, contentType: 'application/json', body: marker, expected: expectedFor(), recordMarkerSha: sha256(marker) });
  assert.equal(c.ready, true);
  assert.equal(c.classification, CLASSIFICATION.SERVED);
});
test('(12) CF "Deployment Not Found" => NOT_SERVED', () => {
  const c = classifyMarkerResponse({ status: 404, contentType: 'text/html', body: '<h1>Deployment not found</h1>', expected: expectedFor(), recordMarkerSha: 'x' });
  assert.equal(c.classification, CLASSIFICATION.NOT_SERVED);
  assert.equal(c.ready, false);
});
test('(13) CF "Nothing is here" => NOT_SERVED', () => {
  const c = classifyMarkerResponse({ status: 404, contentType: 'text/html', body: 'Nothing is here.', expected: expectedFor(), recordMarkerSha: 'x' });
  assert.equal(c.classification, CLASSIFICATION.NOT_SERVED);
});
test('(14) app-owned 404 NOT confused with CF no-deployment (MARKER_NOT_SERVED)', () => {
  const c = classifyMarkerResponse({ status: 404, contentType: 'text/html', body: '<html><body>Page not found — Free2AITools</body></html>', expected: expectedFor(), recordMarkerSha: 'x' });
  assert.equal(c.classification, CLASSIFICATION.MARKER_NOT_SERVED);
  assert.notEqual(c.classification, CLASSIFICATION.NOT_SERVED);
});
test('(15) wrong marker identity rejected (IDENTITY_MISMATCH, terminal)', () => {
  const marker = markerBytesFor({ sourceSha: 'd'.repeat(40) });
  const c = classifyMarkerResponse({ status: 200, contentType: 'application/json', body: marker, expected: expectedFor(), recordMarkerSha: sha256(marker) });
  assert.equal(c.classification, CLASSIFICATION.IDENTITY_MISMATCH);
  assert.equal(c.terminal, true);
});
test('(16) malformed marker rejected (IDENTITY_MALFORMED)', () => {
  const c1 = classifyMarkerResponse({ status: 200, contentType: 'application/json', body: '{not json', expected: expectedFor(), recordMarkerSha: 'x' });
  assert.equal(c1.classification, CLASSIFICATION.IDENTITY_MALFORMED);
  const c2 = classifyMarkerResponse({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema_version: 'x' }), expected: expectedFor(), recordMarkerSha: 'x' });
  assert.equal(c2.classification, CLASSIFICATION.IDENTITY_MALFORMED);
});

// --------------------------- §J poll behaviour ------------------------------
test('(17) marker timeout reaches hard ceiling => READINESS_TIMEOUT', async () => {
  const clock = makeClock();
  const fetchMarker = async () => { clock.tick(REQUEST_TIMEOUT_MS); return { error: 'timeout' }; };
  const r = await pollReadiness({ url: recordFor().preview_url + '/m.json', expected: expectedFor(), recordMarkerSha: 'x', deps: { fetchMarker, now: clock.now, sleep: clock.sleep } });
  assert.equal(r.ready, false);
  assert.equal(r.classification, CLASSIFICATION.READINESS_TIMEOUT);
  assert.ok(clock.now() <= MAX_WALL_CLOCK_MS + INTERVAL_MS + REQUEST_TIMEOUT_MS);
});
test('(18) poll stops immediately on success (single request)', async () => {
  const clock = makeClock();
  const marker = markerBytesFor();
  let calls = 0;
  const fetchMarker = async () => { calls++; return { status: 200, contentType: 'application/json', body: marker }; };
  const r = await pollReadiness({ url: recordFor().preview_url + '/m.json', expected: expectedFor(), recordMarkerSha: sha256(marker), deps: { fetchMarker, now: clock.now, sleep: clock.sleep } });
  assert.equal(r.ready, true);
  assert.equal(calls, 1);
  assert.equal(r.attempt_count, 1);
});
test('(19) max attempt count enforced (<= MAX_ATTEMPTS requests)', async () => {
  const clock = makeClock();
  let calls = 0;
  // instantaneous 404s, no time consumed -> attempt cap (not wall clock) ends it.
  const fetchMarker = async () => { calls++; return { status: 404, contentType: 'text/html', body: 'x' }; };
  const r = await pollReadiness({ url: recordFor().preview_url + '/m.json', expected: expectedFor(), recordMarkerSha: 'x', deps: { fetchMarker, now: clock.now, sleep: clock.sleep } });
  assert.equal(calls, MAX_ATTEMPTS);
  assert.equal(r.classification, CLASSIFICATION.MARKER_NOT_SERVED);
});
test('(20) max wall-clock enforced (stops before MAX_ATTEMPTS)', async () => {
  const clock = makeClock();
  let calls = 0;
  // each request consumes the full per-request timeout; with INTERVAL sleeps the
  // wall clock hits the ceiling well before 18 attempts.
  const fetchMarker = async () => { calls++; clock.tick(REQUEST_TIMEOUT_MS); return { error: 'timeout' }; };
  const r = await pollReadiness({ url: recordFor().preview_url + '/m.json', expected: expectedFor(), recordMarkerSha: 'x', deps: { fetchMarker, now: clock.now, sleep: clock.sleep } });
  assert.ok(calls < MAX_ATTEMPTS, `expected < ${MAX_ATTEMPTS} attempts, got ${calls}`);
  assert.ok(clock.now() <= MAX_WALL_CLOCK_MS + REQUEST_TIMEOUT_MS + INTERVAL_MS);
});

// --------------------------- §K host firewall -------------------------------
test('(21) production host rejected (TARGET_INVALID)', () => {
  assert.equal(classifyTargetHost('https://free2aitools.com/x').classification, CLASSIFICATION.TARGET_INVALID);
  assert.equal(classifyTargetHost('https://www.free2aitools.com/x').classification, CLASSIFICATION.TARGET_INVALID);
});
test('(22) project bare subdomain rejected (TARGET_INVALID)', () => {
  assert.equal(classifyTargetHost('https://ai-nexus.pages.dev/x').classification, CLASSIFICATION.TARGET_INVALID);
});
test('(23) deploy-emitted exact-hash alias accepted', () => {
  assert.equal(classifyTargetHost('https://a1b2c3d4.ai-nexus.pages.dev/x').ok, true);
  assert.equal(classifyTargetHost('https://ta2-pr-1-run-9-attempt-1-candidate.ai-nexus.pages.dev/x').ok, true);
});

// --------------------- §L/§M app-smoke separation ---------------------------
test('(24) nominal arm cannot smoke before readiness', () => {
  const v = computeArmVerdict({ arm: 'candidate', readiness: { ready: false, classification: CLASSIFICATION.NOT_SERVED }, appSmoke: { pass: true } });
  assert.equal(v.app_smoke_classification, 'NOT_RUN');
  assert.notEqual(v.final_arm_verdict, ARM_VERDICT.NOMINAL_PASS);
});
test('(25) broken cannot get EXPECTED_RUNTIME_FAIL before readiness', () => {
  const v = computeArmVerdict({ arm: 'broken', readiness: { ready: false, classification: CLASSIFICATION.NOT_SERVED }, brokenSignals: { ssrFailureCount: 6, markerStill200: true } });
  assert.notEqual(v.final_arm_verdict, ARM_VERDICT.BROKEN_EXPECTED_FAIL);
  assert.equal(v.final_arm_verdict, ARM_VERDICT.INFRASTRUCTURE_FAILURE);
});
test('(26) broken marker-served + expected SSR failure accepted', () => {
  const v = computeArmVerdict({ arm: 'broken', readiness: { ready: true, classification: CLASSIFICATION.SERVED }, brokenSignals: { sourceShaMatches: true, hashesMatch: true, ssrFailureCount: 4, anyRouteCfNotServed: false, markerStill200: true, productionContacted: false, healthyApiContract: false } });
  assert.equal(v.final_arm_verdict, ARM_VERDICT.BROKEN_EXPECTED_FAIL);
});
test('(27) broken healthy runtime rejected (UNEXPECTED_RUNTIME_PASS)', () => {
  const v = computeArmVerdict({ arm: 'broken', readiness: { ready: true, classification: CLASSIFICATION.SERVED }, brokenSignals: { sourceShaMatches: true, hashesMatch: true, ssrFailureCount: 0, anyRouteCfNotServed: false, markerStill200: true, productionContacted: false, healthyApiContract: true } });
  assert.equal(v.final_arm_verdict, ARM_VERDICT.UNEXPECTED_RUNTIME_PASS);
});

// --------------------------- §N qualification -------------------------------
function goodArms() {
  return {
    candidate: { arm: 'candidate', final_arm_verdict: ARM_VERDICT.NOMINAL_PASS, final_readiness_classification: CLASSIFICATION.SERVED },
    recovered: { arm: 'recovered', final_arm_verdict: ARM_VERDICT.NOMINAL_PASS, final_readiness_classification: CLASSIFICATION.SERVED },
    current: { arm: 'current', final_arm_verdict: ARM_VERDICT.NOMINAL_PASS, final_readiness_classification: CLASSIFICATION.SERVED },
    broken: { arm: 'broken', final_arm_verdict: ARM_VERDICT.BROKEN_EXPECTED_FAIL, final_readiness_classification: CLASSIFICATION.SERVED },
  };
}
test('(28) nominal NOT_SERVED keeps qualification red', () => {
  const arms = goodArms();
  arms.candidate = { arm: 'candidate', final_arm_verdict: CLASSIFICATION.NOT_SERVED, final_readiness_classification: CLASSIFICATION.NOT_SERVED };
  assert.equal(computeQualificationVerdict(arms).verdict, 'FAIL');
});
test('(29) broken NOT_SERVED keeps qualification red', () => {
  const arms = goodArms();
  arms.broken = { arm: 'broken', final_arm_verdict: ARM_VERDICT.INFRASTRUCTURE_FAILURE, final_readiness_classification: CLASSIFICATION.NOT_SERVED };
  assert.equal(computeQualificationVerdict(arms).verdict, 'FAIL');
});
test('(30) all nominal NOT_SERVED => GATE_NON_DISCRIMINATING', () => {
  const arms = goodArms();
  for (const a of ['candidate', 'recovered', 'current']) arms[a] = { arm: a, final_arm_verdict: CLASSIFICATION.NOT_SERVED, final_readiness_classification: CLASSIFICATION.NOT_SERVED };
  const r = computeQualificationVerdict(arms);
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.reasons.includes('GATE_NON_DISCRIMINATING'));
});
test('(31) one stale arm keeps red', () => {
  const arms = goodArms();
  arms.recovered = { arm: 'recovered', final_arm_verdict: CLASSIFICATION.STALE, final_readiness_classification: CLASSIFICATION.STALE };
  assert.equal(computeQualificationVerdict(arms).verdict, 'FAIL');
});
test('(32) one missing evidence record keeps red (INCOMPLETE_EVIDENCE)', () => {
  const arms = goodArms();
  delete arms.current;
  const r = computeQualificationVerdict(arms);
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.reasons.some((x) => x.startsWith('INCOMPLETE_EVIDENCE')));
});
test('(33) production fallback impossible (only the given host is contacted)', async () => {
  // production target is fatal up-front, and the poll never contacts another host.
  assert.equal(classifyTargetHost('https://free2aitools.com/m').ok, false);
  const clock = makeClock();
  const url = recordFor().preview_url + '/m.json';
  const seen = [];
  const fetchMarker = async (u) => { seen.push(new URL(u).hostname); return { status: 404, contentType: 'text/html', body: 'x' }; };
  await pollReadiness({ url, expected: expectedFor(), recordMarkerSha: 'x', deps: { fetchMarker, now: clock.now, sleep: clock.sleep } });
  assert.ok(seen.every((h) => h === new URL(url).hostname));
  assert.ok(!seen.some((h) => h.includes('free2aitools.com')));
});
test('(34) failed-jobs partial-rerun fixture fails closed', () => {
  // a record from a prior attempt (the artifact a failed-jobs rerun would re-find)
  // must fail closed with the redeploy guidance — never a pass.
  const v = validateDeploymentRecord(recordFor({ github_run_attempt: '2' }), expectedFor());
  assert.equal(v.ok, false);
  assert.equal(v.classification, CLASSIFICATION.STALE);
  assert.ok(operatorGuidance(v.classification).includes(REDEPLOY_TOKEN));
  assert.ok(!operatorGuidance(v.classification).includes(FORBIDDEN_RERUN_PHRASE));
});
test('(35) all four same-attempt valid => SUCCESS', () => {
  const r = computeQualificationVerdict(goodArms());
  assert.equal(r.verdict, 'SUCCESS');
  assert.equal(r.reasons.length, 0);
});

// --------------------------- §R interface hygiene ---------------------------
const READINESS_SRC = fs.readFileSync(path.join(HERE, 'ta2-preview-readiness.mjs'), 'utf8');
test('(36) no deploy op occurs in the helper (no wrangler/child_process/spawn)', () => {
  assert.ok(!/child_process/.test(READINESS_SRC));
  assert.ok(!/wrangler/.test(READINESS_SRC));
  assert.ok(!/spawn/.test(READINESS_SRC));
  assert.ok(!/pages deploy/.test(READINESS_SRC));
});
test('(37) no credential accepted by helper interface', () => {
  assert.ok(!/apiToken|API_TOKEN|CF_PREVIEW|SECRET|Authorization|process\.env\.\w*TOKEN/.test(READINESS_SRC));
});
test('(38) evidence body capture bounded + sanitized', () => {
  const big = 'A'.repeat(5000) + ' <script>';
  const fp = bodyFingerprint(big);
  assert.ok(fp.prefix.length <= 256);
  assert.ok(!/[^\x20-\x7e]/.test(fp.prefix));
  assert.equal(fp.body_length, Buffer.byteLength(big, 'utf8'));
});
test('(39) response fingerprints deterministic', () => {
  const a = bodyFingerprint('hello world');
  const b = bodyFingerprint('hello world');
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, crypto.createHash('sha256').update('hello world').digest('hex'));
});
test('(40) workflow + smoke wire run-attempt-bound artifact + structured (not job-color) consumption', () => {
  const wf = fs.readFileSync(path.join(HERE, '..', '..', '.github', 'workflows', 'ta2-preview-runtime-gate.yml'), 'utf8');
  // run-attempt-bound deployment-record artifact name (run id + run attempt + arm).
  assert.ok(/ta2-deploy-record-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-/.test(wf), 'workflow lacks run-attempt-bound artifact name');
  // structured qualification consumes per-arm records via the readiness module.
  assert.ok(/ta2-preview-readiness\.mjs --qualify/.test(wf), 'workflow does not run structured --qualify');
  // readiness gate invoked in the smoke job (mutation 1 guard).
  const smoke = fs.readFileSync(path.join(HERE, 'ta2-preview-smoke.mjs'), 'utf8');
  assert.ok(/ta2-preview-readiness\.mjs/.test(smoke), 'smoke does not invoke the readiness module');
  assert.ok(/pollReadiness|validateDeploymentRecord/.test(smoke), 'smoke does not call the readiness gate functions');
});

// ----------------------- supporting invariants ------------------------------
test('pinned §J constants', () => {
  assert.equal(MAX_ATTEMPTS, 18);
  assert.equal(INTERVAL_MS, 10_000);
  assert.equal(REQUEST_TIMEOUT_MS, 8_000);
  assert.equal(MAX_WALL_CLOCK_MS, 180_000);
});
test('ctIsJson + detectCloudflareNotServed predicates', () => {
  assert.equal(ctIsJson('application/json; charset=utf-8'), true);
  assert.equal(ctIsJson('text/html'), false);
  assert.equal(detectCloudflareNotServed('Deployment not found'), true);
  assert.equal(detectCloudflareNotServed('normal page'), false);
});
test('checkMarkerIdentity flags each differing field', () => {
  const obj = buildMarkerObject({ runId: RUN_ID, runAttempt: RUN_ATTEMPT, arm: 'broken', sourceSha: SRC, buildArtifactSha256: BUILD_HASH, createdAtUtc: 'x' });
  assert.deepEqual(checkMarkerIdentity(obj, expectedFor()), ['arm']);
});
test('classifyBrokenArm direct signature gates', () => {
  assert.equal(classifyBrokenArm({ sourceShaMatches: true, hashesMatch: true, ssrFailureCount: 3, anyRouteCfNotServed: false, markerStill200: true, productionContacted: false, healthyApiContract: false }), ARM_VERDICT.BROKEN_EXPECTED_FAIL);
  assert.equal(classifyBrokenArm({ markerStill200: false }), CLASSIFICATION.NOT_SERVED);
  assert.equal(classifyBrokenArm({ markerStill200: true, productionContacted: true }), CLASSIFICATION.TARGET_INVALID);
  assert.equal(classifyBrokenArm({ markerStill200: true, anyRouteCfNotServed: true }), CLASSIFICATION.NOT_SERVED);
});
test('CONTROLS coverage', () => { assert.deepEqual(CONTROLS, ['candidate', 'broken', 'recovered', 'current']); });
