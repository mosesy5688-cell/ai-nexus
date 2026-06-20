#!/usr/bin/env node
// scripts/ci/ta2-preview-smoke.mjs
// TA2-RUNTIME-GATE PR-G1 — 6-endpoint COLD-START smoke against an ephemeral
// Cloudflare Pages PREVIEW deployment. Pure Node 24 fetch, NO new deps.
//
// Incident class caught (TA2-INCIDENT-1): a telemetry import pulled into the
// Worker-ENTRY cold-load chain made every Worker/SSR route return empty-body
// HTTP 500 in prod, while astro-build/vitest/tsc/local-miniflare all FALSE-
// PASSED. Only a REAL CF preview deploy + a COLD first request exposes it.
//
// Contract: argv[2] = preview URL (MUST be a *.pages.dev preview, NEVER the
// production custom domain free2aitools.com). The runner asserts that, issues
// the FIRST /api/v1/health request IMMEDIATELY (no warm-up), and FAILS CLOSED on
// any timeout / 5xx / empty body / wrong content-type / parse failure. It records
// ONLY status, content-type, body length, body SHA-256, parse result, the EXACT
// built-commit identity (control / requested_ref / resolved_commit_sha /
// build_artifact_sha256), the deployment ID and the preview URL — NEVER full
// bodies, Authorization headers or secrets.
//
// TA2-GATE-PROVENANCE-1 (D-78): the recorded identity binds this runtime result
// to the EXACT commit the build leg checked out. resolved_commit_sha MUST be the
// PROPAGATED build identity (read from deploy-info.json via env), NEVER github.sha
// / the PR merge-context SHA. The smoke FAILS CLOSED if resolved_commit_sha is
// absent or not a full 40-hex SHA — an identity defect can never pass silently.
import crypto from 'node:crypto';

const PREVIEW_URL = (process.argv[2] || process.env.PREVIEW_URL || '').trim();
const CONTROL = (process.env.CONTROL || '').trim();
const REQUESTED_REF = (process.env.REQUESTED_REF || '').trim();
const RESOLVED_COMMIT_SHA = (process.env.RESOLVED_COMMIT_SHA || '').trim();
const BUILD_ARTIFACT_SHA256 = (process.env.BUILD_ARTIFACT_SHA256 || '').trim();
const DEPLOYMENT_ID = (process.env.DEPLOYMENT_ID || '').trim();
const PER_REQ_TIMEOUT_MS = 30000;
const PROD_HOST = 'free2aitools.com';
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// The EXACT six endpoints that 500'd in TA2-INCIDENT-1. Order matters: cold
// /api/v1/health is issued FIRST (entry/module-load failure shows here first,
// pre-route). `kind` selects the structure assertion. No warm-up request.
export const ENDPOINTS = [
  { path: '/api/v1/health', method: 'GET', ct: 'json', kind: 'health' },
  { path: '/api/v1/search?q=test', method: 'GET', ct: 'json', kind: 'search' },
  { path: '/api/mcp', method: 'POST', ct: 'json', kind: 'mcp',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } },
  { path: '/api/v1/datasets', method: 'GET', ct: 'json', kind: 'json' },
  { path: '/openapi.json', method: 'GET', ct: 'json', kind: 'openapi' },
  { path: '/llms.txt', method: 'GET', ct: 'text', kind: 'text' },
];

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Production-exclusion hard assert: the smoke MUST run against the preview only.
// Pure predicate (throws a string on violation) — exported for hermetic tests.
export function checkPreviewUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw `preview URL is not a valid URL: "${url}"`; }
  if (u.protocol !== 'https:') throw `preview URL must be https: "${url}"`;
  const host = u.hostname.toLowerCase();
  if (host === PROD_HOST || host.endsWith(`.${PROD_HOST}`)) {
    throw `refusing to smoke the production custom domain (${host})`;
  }
  if (!host.endsWith('.pages.dev')) {
    throw `preview URL host must be under *.pages.dev, got "${host}"`;
  }
  return u;
}

function assertPreviewUrl(url) {
  try { return checkPreviewUrl(url); } catch (msg) { fail(msg); }
}

export function ctIsSane(kind, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (kind === 'text') return ct.startsWith('text/');
  return ct.includes('application/json');
}

// Minimum-structure assertion per endpoint kind. Returns a parse-result label
// or throws a string describing the violation.
export function assertStructure(kind, bodyText) {
  if (kind === 'text') {
    if (!bodyText.trim()) throw 'empty text body';
    return 'text-ok';
  }
  let obj;
  try { obj = JSON.parse(bodyText); } catch { throw 'body is not valid JSON'; }
  if (kind === 'health') {
    if (obj === null || typeof obj !== 'object') throw 'health is not a JSON object';
  } else if (kind === 'search') {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw 'search did not return a JSON object';
    }
  } else if (kind === 'mcp') {
    if (obj === null || typeof obj !== 'object') throw 'mcp is not a JSON object';
    if (obj.jsonrpc !== '2.0') throw 'mcp is not a valid JSON-RPC 2.0 envelope';
    if (!('result' in obj) && !('error' in obj)) throw 'mcp envelope has no result/error';
  } else if (kind === 'openapi') {
    if (obj === null || typeof obj !== 'object') throw 'openapi is not a JSON object';
    if (!('openapi' in obj)) throw 'openapi.json missing "openapi" key';
    if (!('paths' in obj)) throw 'openapi.json missing "paths" key';
  } else {
    if (obj === null || typeof obj !== 'object') throw 'response is not a JSON object';
  }
  return 'json-ok';
}

export async function probe(base, ep) {
  const url = new URL(ep.path, base).toString();
  const headers = { Accept: ep.ct === 'text' ? 'text/plain' : 'application/json' };
  const init = { method: ep.method, headers, signal: AbortSignal.timeout(PER_REQ_TIMEOUT_MS) };
  if (ep.body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(ep.body);
  }
  const rec = { path: ep.path, method: ep.method };
  let res, text;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const reason = e && e.name === 'TimeoutError' ? `timeout after ${PER_REQ_TIMEOUT_MS}ms` : `connection failed: ${e.message}`;
    return { rec, error: reason };
  }
  rec.status = res.status;
  rec.contentType = res.headers.get('content-type') || '';
  try { text = await res.text(); } catch (e) { return { rec, error: `body read failed: ${e.message}` }; }
  rec.bodyLength = Buffer.byteLength(text, 'utf8');
  rec.bodySha256 = crypto.createHash('sha256').update(text).digest('hex');
  // FAIL-CLOSED assertions (any violation = ordinary gate FAIL).
  if (res.status >= 500) return { rec, error: `5xx status ${res.status}` };
  if (rec.bodyLength === 0) return { rec, error: 'empty body' };
  if (!ctIsSane(ep.kind, rec.contentType)) return { rec, error: `bad content-type "${rec.contentType}"` };
  try {
    rec.parse = assertStructure(ep.kind, text);
  } catch (msg) {
    return { rec, error: `structure: ${msg}` };
  }
  return { rec };
}

// Identity fail-closed: the propagated resolved_commit_sha MUST be a full 40-hex
// SHA. An abbreviated / missing / requested_ref-only identity is an identity
// DEFECT and the smoke fails closed (never records a runtime PASS without binding
// it to the EXACT built commit). Exported pure predicate for hermetic tests.
export function checkBuildIdentity({ resolvedCommitSha }) {
  const sha = (resolvedCommitSha || '').trim();
  if (!sha) throw 'resolved_commit_sha is absent (identity not propagated from build)';
  if (!FULL_SHA_RE.test(sha)) throw `resolved_commit_sha "${sha}" is not a full 40-hex SHA`;
  return sha;
}

async function main() {
  const base = assertPreviewUrl(PREVIEW_URL);
  // FAIL CLOSED before any probe if the EXACT built-commit identity is defective.
  let resolvedCommitSha;
  try {
    resolvedCommitSha = checkBuildIdentity({ resolvedCommitSha: RESOLVED_COMMIT_SHA });
  } catch (msg) { fail(`identity: ${msg}`); }
  console.log(`TA2 cold-start smoke -> ${base.origin}`);
  console.log(`control=${CONTROL || '(unset)'} requested_ref=${REQUESTED_REF || '(unset)'}`);
  console.log(`resolved_commit_sha=${resolvedCommitSha} build_artifact_sha256=${BUILD_ARTIFACT_SHA256 || '(unset)'} deployment_id=${DEPLOYMENT_ID || '(unset)'}`);
  const records = [];
  let failed = 0;
  // STRICTLY SEQUENTIAL, /api/v1/health FIRST and IMMEDIATELY (no warm-up):
  // the cold Worker-entry evaluation must be exercised on the very first request.
  for (const ep of ENDPOINTS) {
    const { rec, error } = await probe(base, ep);
    if (error) {
      rec.result = 'FAIL';
      rec.failReason = error;
      failed++;
      console.error(`  [FAIL] ${ep.method} ${ep.path} -> ${error} (status=${rec.status ?? 'n/a'}, len=${rec.bodyLength ?? 'n/a'})`);
    } else {
      rec.result = 'PASS';
      console.log(`  [PASS] ${ep.method} ${ep.path} -> ${rec.status} ${rec.contentType} len=${rec.bodyLength} (${rec.parse})`);
    }
    records.push(rec);
  }
  const summary = {
    schema: 'ta2-preview-smoke/v2',
    control: CONTROL || null,
    requested_ref: REQUESTED_REF || null,
    // The EXACT built-commit identity, PROPAGATED from the build artifact (NOT
    // github.sha). This is the field that binds the runtime result to the commit
    // each matrix control actually built.
    resolved_commit_sha: resolvedCommitSha,
    build_artifact_sha256: BUILD_ARTIFACT_SHA256 || null,
    deployment_id: DEPLOYMENT_ID || null,
    preview_url: base.origin,
    endpoint_count: ENDPOINTS.length,
    failed,
    verdict: failed === 0 ? 'PASS' : 'FAIL',
    records, // status/content-type/length/sha256/parse ONLY — never raw bodies/headers/secrets
  };
  const out = (process.env.SMOKE_RESULT_PATH || '').trim();
  if (out) {
    const fs = await import('node:fs');
    fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(`wrote smoke result -> ${out}`);
  }
  console.log(`SMOKE_VERDICT=${summary.verdict}`);
  if (failed > 0) process.exit(1);
}

// Auto-run ONLY when executed directly (not when imported by the hermetic tests).
const INVOKED_DIRECTLY = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`.replace('file:////', 'file:///');
if (INVOKED_DIRECTLY || process.argv[1]?.endsWith('ta2-preview-smoke.mjs')) {
  main().catch((e) => fail(`unexpected smoke error: ${e && e.stack ? e.stack : e}`));
}
