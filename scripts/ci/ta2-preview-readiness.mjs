// scripts/ci/ta2-preview-readiness.mjs
// Invoked as `node scripts/ci/ta2-preview-readiness.mjs --poll`
//          / `node scripts/ci/ta2-preview-readiness.mjs --qualify <evidence-dir>`
// (no shebang: the hermetic node:test suite imports this module; the workflow
// always calls it via `node`).
//
// TA2 PREVIEW-GATE RELIABILITY (Founder D-207 §G-§K, §J served-readiness, §M
// broken-arm signature, §N qualification truth table, §O structured evidence,
// §P recovery guidance). PURE Node built-ins ONLY (node:crypto, node:fs,
// node:path). NO network is performed by the testable core — every HTTP request
// and every clock read is INJECTED so timeout / ceiling behaviour is
// deterministic and fast under node:test. NO edge-deploy operation, NO CF CLI, NO
// credential is referenced or accepted by this helper's interface.
//
// WHY THIS EXISTS: a Cloudflare Pages preview can report deploy-success while the
// edge has NOT yet served the new tree (propagation), or while serving a STALE
// prior-attempt deployment. Deploy-success is therefore NOT proof the gate tested
// the candidate. This module proves the EXACT same-attempt build is SERVED by
// fetching a unique per-run-attempt deployment-identity MARKER and matching every
// identity field + the marker's exact byte-sha256 against the deployment record.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// §J PINNED readiness constants (NO exponential backoff, NO unbounded retry,
// NO deploy rerun, NO alternate hostname, NO production fallback).
// ---------------------------------------------------------------------------
export const MAX_ATTEMPTS = 18;
export const INTERVAL_MS = 10_000; // ~10s between request starts
export const REQUEST_TIMEOUT_MS = 8_000; // no single request > 8s
export const MAX_WALL_CLOCK_MS = 180_000; // total <= 180s

export const PROD_HOST = 'free2aitools.com';
export const PAGES_PROJECT = 'ai-nexus';
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_BODY_EVIDENCE = 256; // §O bounded diagnostic prefix

// Canonical classifications (§K taxonomy + §M/§N verdict tokens). All keep
// qualification-verdict = FAIL except SERVED / the two positive arm verdicts.
export const CLASSIFICATION = Object.freeze({
  SERVED: 'DEPLOYMENT_IDENTITY_SERVED',
  STALE: 'STALE_PREVIEW_DEPLOYMENT',
  NOT_SERVED: 'TA2_PREVIEW_NOT_SERVED',
  MARKER_NOT_SERVED: 'TA2_PREVIEW_MARKER_NOT_SERVED',
  IDENTITY_MISMATCH: 'TA2_PREVIEW_IDENTITY_MISMATCH',
  IDENTITY_MALFORMED: 'TA2_PREVIEW_IDENTITY_MALFORMED',
  READINESS_TIMEOUT: 'TA2_PREVIEW_READINESS_TIMEOUT',
  TARGET_INVALID: 'TA2_PREVIEW_TARGET_INVALID',
  EXECUTION_INVALID: 'EXECUTION_INVALID',
});

// Arm-level final verdicts (§L/§M) consumed by §N qualification truth table.
export const ARM_VERDICT = Object.freeze({
  NOMINAL_PASS: 'IDENTITY_SERVED_APP_SMOKE_PASS',
  BROKEN_EXPECTED_FAIL: 'IDENTITY_SERVED_EXPECTED_RUNTIME_FAIL',
  APP_SMOKE_FAIL: 'APP_SMOKE_FAIL',
  UNEXPECTED_RUNTIME_PASS: 'UNEXPECTED_RUNTIME_PASS',
  INFRASTRUCTURE_FAILURE: 'INFRASTRUCTURE_FAILURE',
  INCOMPLETE_EVIDENCE: 'INCOMPLETE_EVIDENCE',
});

export const CONTROLS = ['candidate', 'broken', 'recovered', 'current'];
export const NOMINAL_ARMS = ['candidate', 'recovered', 'current'];

// §P RECOVERY GUIDANCE — exact strings; the operator banner MUST contain the
// full-redeploy token and MUST NEVER authorise / instruct a failed-jobs rerun.
export const REDEPLOY_TOKEN = 'FULL ALL-JOBS REDEPLOY REQUIRED';
export const FORBIDDEN_RERUN_PHRASE = 'RE-RUN FAILED JOBS';
export const RECOVERY_GUIDANCE = Object.freeze({
  [CLASSIFICATION.STALE]:
    'A failed-jobs rerun cannot establish same-attempt producer provenance. A separately authorized full all-jobs redeploy is required.',
  [CLASSIFICATION.NOT_SERVED]:
    'The preview deployment was not served within the bounded readiness window. The required gate remains blocked; no automatic rerun was initiated.',
});

// Operator guidance banner for a failure classification. NEVER states a rerun was
// authorized; ALWAYS carries the full-redeploy token for the provenance failures.
export function operatorGuidance(classification) {
  const served = RECOVERY_GUIDANCE[classification] || RECOVERY_GUIDANCE[CLASSIFICATION.NOT_SERVED];
  const banner = `${REDEPLOY_TOKEN} — ${served}`;
  if (banner.includes(FORBIDDEN_RERUN_PHRASE)) throw new Error('guidance must not instruct a failed-jobs rerun');
  return banner;
}

// ---------------------------------------------------------------------------
// Pure predicates.
// ---------------------------------------------------------------------------
export function ctIsJson(contentType) {
  return (contentType || '').toLowerCase().includes('json');
}

// Cloudflare "no deployment at this host" body — distinct from an APP-owned 404.
export function detectCloudflareNotServed(bodyText) {
  const t = (bodyText || '').toLowerCase();
  return t.includes('deployment not found') || t.includes('nothing is here');
}

// §O bounded + sanitized body evidence: a sha256 fingerprint + a bounded ASCII
// prefix, NEVER the full HTML body.
export function bodyFingerprint(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    body_length: buf.length,
    prefix: buf.subarray(0, MAX_BODY_EVIDENCE).toString('utf8').replace(/[^\x20-\x7e]/g, '.'),
  };
}

// §K wrong/production host => TARGET_INVALID. Rejects production custom domain AND
// the project BARE subdomain (ai-nexus.pages.dev = production alias); ACCEPTS a
// per-branch / deploy-emitted exact-hash alias (<label>.ai-nexus.pages.dev).
export function classifyTargetHost(url, { project = PAGES_PROJECT } = {}) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, classification: CLASSIFICATION.TARGET_INVALID, reason: 'invalid url' }; }
  if (u.protocol !== 'https:') return { ok: false, classification: CLASSIFICATION.TARGET_INVALID, reason: 'not https' };
  const host = u.hostname.toLowerCase();
  if (host === PROD_HOST || host.endsWith(`.${PROD_HOST}`)) {
    return { ok: false, classification: CLASSIFICATION.TARGET_INVALID, reason: 'production custom domain' };
  }
  if (!host.endsWith('.pages.dev')) {
    return { ok: false, classification: CLASSIFICATION.TARGET_INVALID, reason: 'not a *.pages.dev preview host' };
  }
  if (host === `${project}.pages.dev`) {
    return { ok: false, classification: CLASSIFICATION.TARGET_INVALID, reason: 'project bare subdomain (production alias)' };
  }
  return { ok: true, host };
}

// §H run-attempt-bound artifact naming. The smoke job MUST consume the deployment
// record for the CURRENT run attempt by this EXACT name — never an unversioned /
// prior-attempt / branch-alias name.
export function deploymentRecordArtifactName({ runId, runAttempt, arm }) {
  return `ta2-deploy-record-${runId}-${runAttempt}-${arm}`;
}
export function isRunAttemptBoundArtifactName(name, { runId, runAttempt, arm }) {
  return name === deploymentRecordArtifactName({ runId, runAttempt, arm });
}

// §G unique deployment-identity marker relative path (preview-only static JSON).
export function markerRelPath({ runId, runAttempt, arm }) {
  return `.well-known/ta2-preview/${runId}-${runAttempt}-${arm}.json`;
}

// §G canonical marker bytes (deterministic key order) so MARKER_SHA256 computed at
// deploy time === sha256 of the bytes the edge serves. NO deploy-tree hash inside
// (no circular hash), NO credential / production hostname.
export function buildMarkerObject({ runId, runAttempt, arm, sourceSha, buildArtifactSha256, createdAtUtc }) {
  return {
    schema_version: 'ta2-preview-marker/v1',
    github_run_id: String(runId),
    github_run_attempt: String(runAttempt),
    arm: String(arm),
    source_sha: String(sourceSha),
    build_artifact_sha256: String(buildArtifactSha256),
    marker_created_at_utc: String(createdAtUtc),
  };
}
export function serializeMarker(obj) {
  // Stable field order via buildMarkerObject; JSON.stringify with no spaces.
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

const MARKER_REQUIRED = ['schema_version', 'github_run_id', 'github_run_attempt', 'arm', 'source_sha', 'build_artifact_sha256', 'marker_created_at_utc'];
function markerStructureValid(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return MARKER_REQUIRED.every((k) => k in obj);
}

// Identity field comparison of a parsed marker against the frozen expectation.
export function checkMarkerIdentity(obj, expected) {
  const mism = [];
  if (String(obj.github_run_id) !== String(expected.githubRunId)) mism.push('github_run_id');
  if (String(obj.github_run_attempt) !== String(expected.githubRunAttempt)) mism.push('github_run_attempt');
  if (String(obj.arm) !== String(expected.arm)) mism.push('arm');
  if (String(obj.source_sha).toLowerCase() !== String(expected.sourceSha).toLowerCase()) mism.push('source_sha');
  if (String(obj.build_artifact_sha256).toLowerCase() !== String(expected.buildArtifactSha256).toLowerCase()) mism.push('build_artifact_sha256');
  return mism;
}

// §J/§K single-response classifier. READY only when: HTTP 200 + JSON-compatible
// content-type + parses + every identity field matches + marker-byte sha256 ===
// the deployment record's marker_sha256. Absence of an error page is NOT enough.
export function classifyMarkerResponse({ status, contentType, body, expected, recordMarkerSha }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const text = buf.toString('utf8');
  const fingerprint = bodyFingerprint(buf);
  // CF "no deployment here" body is checked FIRST — it may arrive as 200 or 404,
  // and is distinct from the application's OWN 404 page.
  if (detectCloudflareNotServed(text)) {
    return { classification: CLASSIFICATION.NOT_SERVED, ready: false, terminal: false, fingerprint };
  }
  if (status !== 200) {
    // marker 404 (or any non-200) WITHOUT a recognized CF body => marker not yet
    // served (keep polling); NEVER ready.
    return { classification: CLASSIFICATION.MARKER_NOT_SERVED, ready: false, terminal: false, fingerprint };
  }
  if (!ctIsJson(contentType)) {
    return { classification: CLASSIFICATION.MARKER_NOT_SERVED, ready: false, terminal: false, fingerprint };
  }
  let obj;
  try { obj = JSON.parse(text); } catch { return { classification: CLASSIFICATION.IDENTITY_MALFORMED, ready: false, terminal: true, fingerprint }; }
  if (!markerStructureValid(obj)) {
    return { classification: CLASSIFICATION.IDENTITY_MALFORMED, ready: false, terminal: true, fingerprint };
  }
  const mism = checkMarkerIdentity(obj, expected);
  if (mism.length) {
    return { classification: CLASSIFICATION.IDENTITY_MISMATCH, ready: false, terminal: true, fingerprint, mismatch: mism };
  }
  const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
  if (recordMarkerSha && actualSha.toLowerCase() !== String(recordMarkerSha).toLowerCase()) {
    return { classification: CLASSIFICATION.IDENTITY_MISMATCH, ready: false, terminal: true, fingerprint, mismatch: ['marker_sha256'] };
  }
  return { classification: CLASSIFICATION.SERVED, ready: true, terminal: true, fingerprint };
}

// §I SAME-ATTEMPT HARD GATE. A missing record OR run-id/run-attempt mismatch =>
// STALE_PREVIEW_DEPLOYMENT; arm / source_sha / build-hash (and optional deploy-
// tree / marker hash) mismatch => EXECUTION_INVALID. Either fails closed.
export function validateDeploymentRecord(record, expected) {
  if (!record || typeof record !== 'object') {
    return { ok: false, classification: CLASSIFICATION.STALE, errors: ['missing current-attempt deployment record'], guidance: operatorGuidance(CLASSIFICATION.STALE) };
  }
  const staleErrors = [];
  const invalidErrors = [];
  if (String(record.github_run_id) !== String(expected.githubRunId)) staleErrors.push(`github_run_id ${record.github_run_id} != ${expected.githubRunId}`);
  if (String(record.github_run_attempt) !== String(expected.githubRunAttempt)) staleErrors.push(`github_run_attempt ${record.github_run_attempt} != ${expected.githubRunAttempt}`);
  if (String(record.arm) !== String(expected.arm)) invalidErrors.push(`arm ${record.arm} != ${expected.arm}`);
  if (String(record.source_sha).toLowerCase() !== String(expected.sourceSha).toLowerCase()) invalidErrors.push(`source_sha ${record.source_sha} != ${expected.sourceSha}`);
  if (String(record.build_artifact_sha256).toLowerCase() !== String(expected.buildArtifactSha256).toLowerCase()) invalidErrors.push(`build_artifact_sha256 ${record.build_artifact_sha256} != ${expected.buildArtifactSha256}`);
  if (expected.deployTreeManifestSha256 && String(record.deploy_tree_manifest_sha256).toLowerCase() !== String(expected.deployTreeManifestSha256).toLowerCase()) {
    invalidErrors.push('deploy_tree_manifest_sha256 mismatch');
  }
  if (expected.markerSha256 && String(record.marker_sha256).toLowerCase() !== String(expected.markerSha256).toLowerCase()) {
    invalidErrors.push('marker_sha256 mismatch');
  }
  if (staleErrors.length) {
    return { ok: false, classification: CLASSIFICATION.STALE, errors: staleErrors.concat(invalidErrors), guidance: operatorGuidance(CLASSIFICATION.STALE) };
  }
  if (invalidErrors.length) {
    return { ok: false, classification: CLASSIFICATION.EXECUTION_INVALID, errors: invalidErrors, guidance: operatorGuidance(CLASSIFICATION.STALE) };
  }
  return { ok: true, classification: CLASSIFICATION.SERVED, errors: [] };
}

// ---------------------------------------------------------------------------
// §J SERVED-READINESS poll. deps = { fetchMarker, now, sleep } are INJECTED:
//   fetchMarker(url) -> { status, contentType, body } | { error: 'timeout'|'network' }
//   now() -> ms ; sleep(ms) -> Promise (advances the injected clock)
// PINNED: first request immediate, later ~INTERVAL apart, <= MAX_ATTEMPTS,
// total <= MAX_WALL_CLOCK; no backoff, no rerun, no alternate host.
// ---------------------------------------------------------------------------
export async function pollReadiness({ url, expected, recordMarkerSha, deps }) {
  const { fetchMarker, now, sleep } = deps;
  // Host firewall BEFORE any request — production / bare-subdomain target is fatal.
  const host = classifyTargetHost(url, { project: expected.project || PAGES_PROJECT });
  if (!host.ok) {
    return { ready: false, classification: host.classification, attempts: [], attempt_count: 0, contacted_hosts: [] };
  }
  const start = now();
  const attempts = [];
  const contactedHosts = [];
  let lastClassification = CLASSIFICATION.READINESS_TIMEOUT;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(INTERVAL_MS);
    if (now() - start > MAX_WALL_CLOCK_MS) { lastClassification = CLASSIFICATION.READINESS_TIMEOUT; break; }
    const ts = now();
    let resp;
    try { resp = await fetchMarker(url); }
    catch (e) { resp = { error: e && e.name === 'TimeoutError' ? 'timeout' : 'network', message: String((e && e.message) || e) }; }
    contactedHosts.push(new URL(url).hostname.toLowerCase());
    if (resp && resp.error) {
      attempts.push({ attempt, timestamp_ms: ts, status: null, content_type: null, body_length: 0, body_fingerprint: null, outcome: `request_${resp.error}` });
      lastClassification = CLASSIFICATION.READINESS_TIMEOUT;
      continue; // timeout/network -> keep polling to the ceiling
    }
    const cls = classifyMarkerResponse({ status: resp.status, contentType: resp.contentType, body: resp.body, expected, recordMarkerSha });
    attempts.push({
      attempt, timestamp_ms: ts, status: resp.status ?? null,
      content_type: resp.contentType ?? null,
      body_length: cls.fingerprint.body_length,
      body_fingerprint: { sha256: cls.fingerprint.sha256, prefix: cls.fingerprint.prefix },
      outcome: cls.classification,
    });
    if (cls.ready) {
      return { ready: true, classification: CLASSIFICATION.SERVED, attempts, attempt_count: attempt, contacted_hosts: contactedHosts };
    }
    lastClassification = cls.classification;
    if (cls.terminal) {
      return { ready: false, classification: cls.classification, attempts, attempt_count: attempt, contacted_hosts: contactedHosts };
    }
  }
  return { ready: false, classification: lastClassification, attempts, attempt_count: attempts.length, contacted_hosts: contactedHosts };
}

// ---------------------------------------------------------------------------
// §M BROKEN-ARM signature. SERVED/EXPECTED_RUNTIME_FAIL only when ALL hold.
// ---------------------------------------------------------------------------
export function classifyBrokenArm(signals) {
  const { sourceShaMatches, hashesMatch, ssrFailureCount, anyRouteCfNotServed, markerStill200, productionContacted, healthyApiContract } = signals;
  if (productionContacted) return CLASSIFICATION.TARGET_INVALID; // (7)
  if (!markerStill200) return CLASSIFICATION.NOT_SERVED; // (6) marker must stay 200 while SSR fail
  if (anyRouteCfNotServed) return CLASSIFICATION.NOT_SERVED; // (5)
  if (healthyApiContract || (ssrFailureCount || 0) < 2) return ARM_VERDICT.UNEXPECTED_RUNTIME_PASS; // (4)(8)
  if (!sourceShaMatches || !hashesMatch) return CLASSIFICATION.EXECUTION_INVALID; // (2)(3)
  return ARM_VERDICT.BROKEN_EXPECTED_FAIL; // (1) exact same-attempt marker already proven served
}

// §L APP-SMOKE SEPARATION + final per-arm verdict. App smoke is considered ONLY
// after deployment-identity readiness passes. Returns an §O-shaped arm verdict.
export function computeArmVerdict({ arm, readiness, appSmoke, brokenSignals, appAlsoNotServed }) {
  const isBroken = arm === 'broken';
  if (!readiness || readiness.ready !== true) {
    const cls = readiness ? readiness.classification : CLASSIFICATION.NOT_SERVED;
    let verdict = cls;
    if (isBroken) {
      // §L a not-served broken arm = INFRASTRUCTURE_FAILURE (NOT EXPECTED_RUNTIME_FAIL);
      // §M(8) both marker AND app routes failing at the serving layer => NOT_SERVED.
      verdict = cls === CLASSIFICATION.NOT_SERVED && appAlsoNotServed
        ? CLASSIFICATION.NOT_SERVED
        : (cls === CLASSIFICATION.NOT_SERVED || cls === CLASSIFICATION.MARKER_NOT_SERVED || cls === CLASSIFICATION.READINESS_TIMEOUT
          ? ARM_VERDICT.INFRASTRUCTURE_FAILURE
          : cls);
    }
    return { arm, final_arm_verdict: verdict, final_readiness_classification: cls, app_smoke_classification: 'NOT_RUN' };
  }
  if (isBroken) {
    const sig = classifyBrokenArm(brokenSignals || {});
    return { arm, final_arm_verdict: sig, final_readiness_classification: CLASSIFICATION.SERVED, app_smoke_classification: (brokenSignals && brokenSignals.appClassification) || 'EXPECTED_RUNTIME_FAIL_SIGNATURE' };
  }
  const pass = appSmoke && appSmoke.pass === true;
  return {
    arm,
    final_arm_verdict: pass ? ARM_VERDICT.NOMINAL_PASS : ARM_VERDICT.APP_SMOKE_FAIL,
    final_readiness_classification: CLASSIFICATION.SERVED,
    app_smoke_classification: pass ? 'APP_SMOKE_PASS' : (appSmoke && appSmoke.classification) || 'APP_SMOKE_FAIL',
  };
}

function isInfraNotServed(cls) {
  return cls === CLASSIFICATION.NOT_SERVED || cls === CLASSIFICATION.MARKER_NOT_SERVED || cls === CLASSIFICATION.READINESS_TIMEOUT;
}

// ---------------------------------------------------------------------------
// §N QUALIFICATION TRUTH TABLE — consumes structured arm records (NEVER job
// color). SUCCESS only when every nominal arm = served + app-smoke-pass AND
// broken = served + expected-runtime-failure signature, AND no disqualifier.
// The non-discrimination guard is SUPPLEMENTAL and NEVER converts FAIL -> SUCCESS.
// ---------------------------------------------------------------------------
export function computeQualificationVerdict(armRecords) {
  // Accept array or map; detect missing + duplicate arms.
  const byArm = {};
  const reasons = [];
  const list = Array.isArray(armRecords) ? armRecords : CONTROLS.map((c) => armRecords[c]).filter(Boolean);
  for (const rec of list) {
    if (!rec || !rec.arm) continue;
    if (byArm[rec.arm]) reasons.push(`DUPLICATE_ARM:${rec.arm}`);
    byArm[rec.arm] = rec;
  }
  for (const c of CONTROLS) {
    if (!byArm[c]) reasons.push(`INCOMPLETE_EVIDENCE:${c}`);
  }
  let pass = reasons.length === 0;
  if (pass) {
    for (const a of NOMINAL_ARMS) {
      if (byArm[a].final_arm_verdict !== ARM_VERDICT.NOMINAL_PASS) { reasons.push(`${a}:${byArm[a].final_arm_verdict}`); pass = false; }
    }
    if (byArm.broken.final_arm_verdict !== ARM_VERDICT.BROKEN_EXPECTED_FAIL) { reasons.push(`broken:${byArm.broken.final_arm_verdict}`); pass = false; }
  }
  // Supplemental non-discrimination guard: if the gate did NOT pass AND every
  // nominal arm shares the SAME infra-not-served signature, the gate is not
  // discriminating between healthy and broken => flag GATE_NON_DISCRIMINATING.
  const allNominalNotServed = NOMINAL_ARMS.every((a) => byArm[a] && isInfraNotServed(byArm[a].final_readiness_classification));
  if (!pass && allNominalNotServed) reasons.push('GATE_NON_DISCRIMINATING');
  return { verdict: pass ? 'SUCCESS' : 'FAIL', reasons };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function realFetchMarker(url) {
  return fetch(url, { method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    .then(async (r) => ({ status: r.status, contentType: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer()) }))
    .catch((e) => ({ error: e && e.name === 'TimeoutError' ? 'timeout' : 'network', message: String((e && e.message) || e) }));
}
const realDeps = {
  fetchMarker: realFetchMarker,
  now: () => Date.now(),
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
};

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function runPoll() {
  // Same-attempt provenance from the CURRENT run attempt's deployment record.
  const recordPath = (process.env.DEPLOYMENT_RECORD_PATH || '').trim();
  const record = recordPath ? readJson(recordPath) : null;
  const expected = {
    githubRunId: (process.env.GITHUB_RUN_ID || '').trim(),
    githubRunAttempt: (process.env.GITHUB_RUN_ATTEMPT || '').trim(),
    arm: (process.env.CONTROL || '').trim(),
    sourceSha: (process.env.EXPECTED_SOURCE_SHA || '').trim(),
    buildArtifactSha256: (process.env.EXPECTED_BUILD_ARTIFACT_SHA256 || '').trim(),
    project: PAGES_PROJECT,
  };
  const v = validateDeploymentRecord(record, expected);
  const evidencePath = (process.env.READINESS_EVIDENCE_PATH || '').trim();
  if (!v.ok) {
    console.error(`::error::SAME-ATTEMPT GATE FAILED (${v.classification}): ${v.errors.join('; ')}`);
    console.error(v.guidance);
    if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify({ ready: false, classification: v.classification, errors: v.errors, attempts: [] }, null, 2));
    process.exit(1);
  }
  if (!FULL_SHA_RE.test(expected.sourceSha)) { console.error(`::error::EXPECTED_SOURCE_SHA "${expected.sourceSha}" not 40-hex`); process.exit(1); }
  const markerUrl = new URL(markerRelPath({ runId: record.github_run_id, runAttempt: record.github_run_attempt, arm: record.arm }), record.preview_url).toString();
  console.log(`TA2 served-readiness -> ${markerUrl}`);
  const result = await pollReadiness({ url: markerUrl, expected, recordMarkerSha: record.marker_sha256, deps: realDeps });
  if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2));
  console.log(`READINESS_CLASSIFICATION=${result.classification} attempts=${result.attempt_count}`);
  if (!result.ready) {
    console.error(`::error::preview not served (${result.classification})`);
    console.error(operatorGuidance(result.classification === CLASSIFICATION.STALE ? CLASSIFICATION.STALE : CLASSIFICATION.NOT_SERVED));
    process.exit(1);
  }
  console.log('READINESS=SERVED (exact same-attempt marker proven served)');
}

function runQualify(argv) {
  const dir = argv[0];
  if (!dir) { console.error('::error::--qualify requires <evidence-dir>'); process.exit(1); }
  const arms = {};
  for (const c of CONTROLS) {
    const rec = readJson(path.join(dir, `ta2-smoke-${c}`, `smoke-${c}.json`));
    if (rec) arms[c] = rec;
  }
  const { verdict, reasons } = computeQualificationVerdict(arms);
  if (verdict !== 'SUCCESS') {
    for (const r of reasons) console.error(`::error::qualification: ${r}`);
    console.error(`QUALIFICATION_VERDICT=FAIL (${reasons.length} reason(s))`);
    process.exit(1);
  }
  console.log('QUALIFICATION_VERDICT=PASS (structured per-arm records; not job color)');
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('ta2-preview-readiness.mjs');
if (isMain) {
  const mode = process.argv[2];
  if (mode === '--poll') runPoll();
  else if (mode === '--qualify') runQualify(process.argv.slice(3));
  else { console.error('usage: ta2-preview-readiness.mjs --poll | --qualify <dir>'); process.exit(2); }
}
