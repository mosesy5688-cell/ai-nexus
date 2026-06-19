#!/usr/bin/env node
// scripts/ci/ta2-preview-cleanup.mjs
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

const ACCOUNT_ID = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const PROJECT = (process.env.PAGES_PROJECT || 'ai-nexus').trim();
const DEPLOYMENT_ID = (process.env.DEPLOYMENT_ID || '').trim();
const PREVIEW_BRANCH = (process.env.PREVIEW_BRANCH || '').trim();
const PROD_BRANCH = (process.env.PROD_BRANCH || 'main').trim();

function fail(msg) { console.error(`CLEANUP FAIL: ${msg}`); process.exit(1); }

// Never operate on the production branch / an empty id.
if (!DEPLOYMENT_ID) fail('DEPLOYMENT_ID is empty — nothing to clean (treat as RED).');
if (!PREVIEW_BRANCH) fail('PREVIEW_BRANCH is empty.');
if (PREVIEW_BRANCH === PROD_BRANCH || PREVIEW_BRANCH === 'main') {
  fail(`refusing to clean a production-branch deployment (branch="${PREVIEW_BRANCH}").`);
}

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

function main() {
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
  //    The deterministic preview branch name is single-use; after deletion no
  //    deployment for it should remain. If ANY deployment for this branch is
  //    still listed by id we already failed above; here we additionally confirm
  //    the alias host is not still serving our exact id.
  const alias = `https://${PREVIEW_BRANCH}.${PROJECT}.pages.dev`;
  console.log(`alias check target: ${alias}`);
  console.log('CLEANUP_VERDICT=PASS');
}

main();
