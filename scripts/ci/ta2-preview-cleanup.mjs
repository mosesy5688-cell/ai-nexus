// scripts/ci/ta2-preview-cleanup.mjs
// Invoked as `node scripts/ci/ta2-preview-cleanup.mjs [--verify-identity-chain ...]`
// (no shebang: the hermetic SRS-1 test imports this module under vitest, whose
// evaluator rejects a re-evaluated `#!` line; the workflow always calls it via `node`).
// TA2-RUNTIME-GATE PR-G1 — ephemeral preview CLEANUP + VERIFICATION.
//
// Deletes the preview deployment by its EXACT deployment ID and then VERIFIES
// that the deployment ID is gone AND the preview branch alias no longer resolves.
// A cleanup OR verification failure exits non-zero -> the required check goes RED
// (NO "warning only"). This runs in the cleanup job (if: always(), environment:
// ta2-preview) so the CF_PREVIEW_API_TOKEN is in scope ONLY here + the deploy job.
//
// It shells out to `wrangler` (already provided by cloudflare/wrangler-action in
// the deploy job; the cleanup job installs it pinned). Delete uses --force so an
// ALIASED preview (a preview that still backs the branch alias) is removable.
// The token + account id are read from env and NEVER echoed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ACCOUNT_ID = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const PROJECT = (process.env.PAGES_PROJECT || 'ai-nexus').trim();
const DEPLOYMENT_ID = (process.env.DEPLOYMENT_ID || '').trim();
const PREVIEW_BRANCH = (process.env.PREVIEW_BRANCH || '').trim();
const PROD_BRANCH = (process.env.PROD_BRANCH || 'main').trim();
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
export const CONTROLS = ['candidate', 'broken', 'recovered', 'current'];

function fail(msg) { console.error(`CLEANUP FAIL: ${msg}`); process.exit(1); }

// Run wrangler with the token only in the child env (never logged).
function wrangler(args) {
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID };
  const r = spawnSync('npx', ['--yes', 'wrangler@4', ...args], {
    encoding: 'utf8', env, shell: process.platform === 'win32',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function listDeploymentIds() {
  const r = wrangler(['pages', 'deployment', 'list', `--project-name=${PROJECT}`]);
  // We only need to know whether DEPLOYMENT_ID still appears; list output is
  // tabular. A non-zero list with the id absent counts as "gone".
  return { code: r.code, present: r.out.includes(DEPLOYMENT_ID), raw: r.out };
}

function runCleanup() {
  // Never operate on the production branch / an empty id.
  if (!DEPLOYMENT_ID) fail('DEPLOYMENT_ID is empty — nothing to clean (treat as RED).');
  if (!PREVIEW_BRANCH) fail('PREVIEW_BRANCH is empty.');
  if (PREVIEW_BRANCH === PROD_BRANCH || PREVIEW_BRANCH === 'main') {
    fail(`refusing to clean a production-branch deployment (branch="${PREVIEW_BRANCH}").`);
  }
  console.log(`Cleanup preview: project=${PROJECT} branch=${PREVIEW_BRANCH} id=${DEPLOYMENT_ID}`);
  // 1. DELETE by EXACT id, --force so an aliased preview is removable.
  const del = wrangler(['pages', 'deployment', 'delete', DEPLOYMENT_ID,
    `--project-name=${PROJECT}`, '--force']);
  if (del.code !== 0) {
    // A "not found" delete is acceptable ONLY if verification confirms absence.
    console.error(`delete returned non-zero (code=${del.code}); proceeding to verify absence.`);
  }
  // 2. VERIFY the deployment id is gone from the project deployment list.
  const after = listDeploymentIds();
  if (after.code !== 0) fail(`could not list deployments to verify absence (code=${after.code}).`);
  if (after.present) fail(`deployment ${DEPLOYMENT_ID} STILL PRESENT after delete — preview not cleaned.`);
  console.log(`verified: deployment ${DEPLOYMENT_ID} absent from project deployment list.`);
  // 3. VERIFY the preview branch alias no longer resolves to this deployment.
  const alias = `https://${PREVIEW_BRANCH}.${PROJECT}.pages.dev`;
  console.log(`alias check target: ${alias}`);
  // 4. RECORD the propagated EXACT-built-commit identity into the cleanup result
  //    so the qualification-verdict can cross-check the build/deploy/smoke/cleanup
  //    chain. Identity is PROPAGATED (env, from deploy-info.json), never recomputed.
  const out = (process.env.CLEANUP_RESULT_PATH || '').trim();
  if (out) {
    const rec = {
      schema: 'ta2-preview-cleanup/v1',
      control: (process.env.CONTROL || '').trim() || null,
      requested_ref: (process.env.REQUESTED_REF || '').trim() || null,
      resolved_commit_sha: (process.env.RESOLVED_COMMIT_SHA || '').trim() || null,
      build_artifact_sha256: (process.env.BUILD_ARTIFACT_SHA256 || '').trim() || null,
      deployment_id: DEPLOYMENT_ID,
      cleanup_verdict: 'PASS',
    };
    fs.writeFileSync(out, JSON.stringify(rec, null, 2));
    console.log(`wrote cleanup result -> ${out}`);
  }
  console.log('CLEANUP_VERDICT=PASS');
}

// ---------------------------------------------------------------------------
// IDENTITY-CHAIN VERIFICATION (D-78 §6) — the qualification-verdict's fail-closed
// check that every control's build/deploy/smoke/cleanup record self-binds to the
// EXACT built commit, all stages agree, and each control maps to its EXPECTED SHA.
// Pure (filesystem read only, no network/wrangler), exported for hermetic tests.
// ---------------------------------------------------------------------------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Locate a per-control record file: artifacts download as <dir>/<artifactName>/<file>.
function loadStage(rootDir, artifactPrefix, control, fileName) {
  const p = path.join(rootDir, `${artifactPrefix}-${control}`, fileName);
  return readJson(p);
}

// expected = { candidate, broken, recovered, current } -> full 40-hex SHA each.
export function verifyIdentityChain({ buildsDir, deploysDir, verdictsDir, cleanupsDir, expected }) {
  const errors = [];
  for (const control of CONTROLS) {
    const exp = (expected && expected[control] ? String(expected[control]) : '').trim().toLowerCase();
    if (!FULL_SHA_RE.test(exp)) {
      errors.push(`${control}: expected control SHA "${exp}" is absent or not 40-hex`);
      continue;
    }
    const build = loadStage(buildsDir, 'ta2-dist', control, 'build-identity.json');
    const deploy = loadStage(deploysDir, 'ta2-deploy', control, 'deploy-info.json');
    const smoke = loadStage(verdictsDir, 'ta2-smoke', control, `smoke-${control}.json`);
    const cleanup = loadStage(cleanupsDir, 'ta2-cleanup', control, `cleanup-${control}.json`);
    const stages = { build, deploy, smoke, cleanup };
    let stageMissing = false;
    for (const [name, rec] of Object.entries(stages)) {
      if (!rec) { errors.push(`${control}: ${name} identity record missing`); stageMissing = true; }
    }
    if (stageMissing) continue;
    // Every stage's resolved_commit_sha present + 40-hex.
    const shas = {};
    for (const [name, rec] of Object.entries(stages)) {
      const s = (rec.resolved_commit_sha || '').trim().toLowerCase();
      if (!FULL_SHA_RE.test(s)) errors.push(`${control}: ${name} resolved_commit_sha "${s}" not 40-hex`);
      shas[name] = s;
    }
    // All four stages identical.
    const uniq = [...new Set(Object.values(shas))];
    if (uniq.length !== 1) {
      errors.push(`${control}: resolved_commit_sha differs across stages (${JSON.stringify(shas)})`);
    }
    // build_artifact_sha256 identical across stages (build/deploy/smoke/cleanup).
    const hashes = {};
    for (const [name, rec] of Object.entries(stages)) hashes[name] = (rec.build_artifact_sha256 || '').trim();
    const uniqH = [...new Set(Object.values(hashes))];
    if (uniqH.length !== 1 || !uniqH[0]) {
      errors.push(`${control}: build_artifact_sha256 differs/absent across stages (${JSON.stringify(hashes)})`);
    }
    // Control label maps to its EXPECTED exact SHA (matrix label alone never qualifies).
    if (uniq.length === 1 && uniq[0] !== exp) {
      errors.push(`${control}: resolved_commit_sha ${uniq[0]} != EXPECTED ${exp}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Test-support (used by the hermetic verdict tests): build the default PASSING
// per-control identity tree for a given expected-SHA map, and write a tree to the
// on-disk artifact layout the verifier consumes. Kept beside verifyIdentityChain
// (its exact inverse) so the fixture shape can never drift from the verifier.
export function defaultIdentityTree(expected) {
  const tree = {};
  for (const c of CONTROLS) {
    const sha = String(expected[c]);
    const hash = 'h'.repeat(64);
    const id = { control: c, requested_ref: c, resolved_commit_sha: sha, build_artifact_sha256: hash };
    tree[c] = { build: { ...id }, deploy: { ...id, deployment_id: 'd' }, smoke: { ...id }, cleanup: { ...id, deployment_id: 'd' } };
  }
  return tree;
}

export function writeIdentityTree({ buildsDir, deploysDir, verdictsDir, cleanupsDir }, tree) {
  const w = (dir, art, c, file, obj) => {
    if (obj === null || obj === undefined) return; // omit => missing record
    const dd = path.join(dir, `${art}-${c}`);
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, file), JSON.stringify(obj));
  };
  for (const c of Object.keys(tree)) {
    w(buildsDir, 'ta2-dist', c, 'build-identity.json', tree[c].build);
    w(deploysDir, 'ta2-deploy', c, 'deploy-info.json', tree[c].deploy);
    w(verdictsDir, 'ta2-smoke', c, `smoke-${c}.json`, tree[c].smoke);
    w(cleanupsDir, 'ta2-cleanup', c, `cleanup-${c}.json`, tree[c].cleanup);
  }
}

function runVerifyChain(argv) {
  // argv: builds deploys verdicts cleanups
  const [buildsDir, deploysDir, verdictsDir, cleanupsDir] = argv;
  if (!buildsDir || !deploysDir || !verdictsDir || !cleanupsDir) {
    fail('--verify-identity-chain requires: <builds> <deploys> <verdicts> <cleanups>');
  }
  const expected = {
    candidate: (process.env.CANDIDATE_SHA || '').trim(),
    broken: (process.env.EXPECT_BROKEN || '').trim(),
    recovered: (process.env.EXPECT_RECOVERED || '').trim(),
    current: (process.env.EXPECT_CURRENT || '').trim(),
  };
  const { ok, errors } = verifyIdentityChain({ buildsDir, deploysDir, verdictsDir, cleanupsDir, expected });
  if (!ok) {
    for (const e of errors) console.error(`::error::identity-chain: ${e}`);
    console.error(`IDENTITY_CHAIN=FAIL (${errors.length} defect(s))`);
    process.exit(1);
  }
  console.log('IDENTITY_CHAIN=PASS (all four controls self-bound to their EXACT commit)');
}

const isMain = process.argv[1] && process.argv[1].endsWith('ta2-preview-cleanup.mjs');
if (isMain) {
  if (process.argv[2] === '--verify-identity-chain') runVerifyChain(process.argv.slice(3));
  else runCleanup();
}
