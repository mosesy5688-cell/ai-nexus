// Static guards for the D-403 STEP 2 target-isolated carrier: workflow shape,
// unreachability of the retired full-POST path, the target input contract and
// the decryption-secret boundary. Behavioural proofs live in d403-target.test.mjs.
//
// ZERO network, ZERO secrets. This file contains the forbidden token strings
// because it is the needle list; it scans only the targets below, never itself.
//
// Run: node --test scripts/audit/d403-target-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.resolve(HERE, '..', '..', '.github', 'workflows', 'reliability-probe.yml');
const COLLECTOR = path.join(HERE, 'd403-target-complete.mjs');

const FORBIDDEN = [
  'PutObjectCommand', 'DeleteObjectCommand', 'DeleteObjectsCommand', 'CopyObjectCommand',
  'CreateMultipartUploadCommand', 'UploadPartCommand', 'lib-storage', 'r2-workflow-cli',
  'wrangler', 'aws s3', 'actions/cache/save', 'actions/cache/delete', 'actions/cache/restore',
  'continue-on-error', '|| true', 'set -x', 'printenv', 'curl ', 'wget ', 'eval(', 'restore-keys',
];
const scan = (t) => FORBIDDEN.filter((n) => t.toLowerCase().includes(n.toLowerCase()));

test('static scan is non-vacuous and no target file carries a forbidden construct', () => {
  assert.deepEqual(scan('new PutObjectCommand({})'), ['PutObjectCommand']);
  assert.deepEqual(scan('uses: actions/cache/restore@v5'), ['actions/cache/restore']);
  assert.deepEqual(scan('clean'), []);
  for (const f of [COLLECTOR, WORKFLOW]) {
    assert.deepEqual(scan(fs.readFileSync(f, 'utf8')), [], `${path.basename(f)} has a forbidden construct`);
  }
});

test('no prefix fallback, discovery or identity fallback exists in the collector', () => {
  const src = fs.readFileSync(COLLECTOR, 'utf8');
  assert.equal(/canonical_id\s*\|\||umid\s*\|\||entity_id\s*\|\|/.test(src), false);
  assert.equal(/restore-keys|startsWith\(.latest|Delimiter/.test(src), false);
  assert.equal(/process\.env\.[A-Z_]*PREFIX/.test(src), false, 'no prefix may come from the environment');
  assert.equal((src.match(/D403_TARGET/g) || []).length, 1, 'exactly one env input is read');
  assert.equal(/member_count_matches_manifest/.test(src), false, 'the conflated POST field must not reappear');
});

test('the full-POST path and C/H cache restores are unreachable from the workflow', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.equal(/d403-post-collect\.mjs/.test(yml), false, 'complete POST collector must not be invoked');
  assert.equal(/actions\/cache/.test(yml), false, 'no cache action of any kind may remain');
  assert.equal(/cycle-30978426411-harvest|global-registry-29963927733/.test(yml), false, 'no C/H cache key may remain');
  assert.equal(/indexnow|d403-indexnow-supplement/i.test(yml), false, 'no delta recapture may remain');
  assert.equal(/h-registry|D403_RESTORED|d403-post-evidence/.test(yml), false);
  assert.match(yml, /run: node scripts\/audit\/d403-target-complete\.mjs/);
  // Exactly one target collector invocation: no matrix, no loop, no second run.
  assert.equal((yml.match(/d403-target-complete\.mjs/g) || []).length, 1);
  assert.equal(/strategy:|matrix:/.test(yml), false);
});

test('workflow pins the required input contract, timeout and least privilege', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(yml, /permissions:\r?\n\s+contents: read\r?\n/);
  assert.equal(/^\s*(id-token|packages|actions|pull-requests|issues|deployments):\s*write/m.test(yml), false);
  assert.match(yml, /timeout-minutes: 60/);
  assert.match(yml, /target:\r?\n\s+description:[^\r\n]*\r?\n\s+required: true\r?\n\s+type: choice\r?\n\s+options:\r?\n\s+- P\r?\n\s+- F/);
  assert.match(yml, /D403_TARGET: \$\{\{ inputs\.target \}\}/);
  assert.match(yml, /if-no-files-found: error/);
  // The internal budget is 44 and lives in code, not in a workflow override.
  assert.equal(/D403_BUDGET_MINUTES/.test(yml), false, 'the budget must not be environment-overridable');
  assert.match(fs.readFileSync(COLLECTOR, 'utf8'), /export const BUDGET_MINUTES = 44;/);
});

test('the decryption secret is bound once, on the target step, and never printed', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const hits = yml.split(/\r?\n/).filter((l) => l.includes('AES_CRYPTO_KEY'));
  assert.equal(hits.length, 1, 'the secret must appear exactly once');
  assert.match(hits[0], /^ {10}AES_CRYPTO_KEY: \$\{\{ secrets\.AES_CRYPTO_KEY \}\}$/);
  const step = yml.slice(yml.indexOf('- name: Complete D-403 handoff target'));
  assert.ok(step.slice(0, step.indexOf('- name: Verify')).includes('AES_CRYPTO_KEY'), 'must be scoped to the target step');
  assert.equal(/echo[^\n]*AES_CRYPTO_KEY|\$AES_CRYPTO_KEY|\$\{AES_CRYPTO_KEY\}/.test(yml), false);
  const src = fs.readFileSync(COLLECTOR, 'utf8');
  assert.equal(/AES_CRYPTO_KEY/.test(src), false, 'the collector never names the secret directly');
  assert.equal(/console\.[a-z]+\([^\n]*(KEY|SECRET)/.test(src), false);
});
