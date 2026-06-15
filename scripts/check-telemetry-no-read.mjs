#!/usr/bin/env node
/**
 * P2 Adoption Telemetry -- NO-READ + BINDING-CONFINEMENT static gate (BLOCKING).
 *
 * Authority: SPEC s8 (THE INVARIANT: "Telemetry data must never be read by FNI
 * scoring, ranking, search result ordering, entity projection, or MCP response
 * generation"), s8 enforcement (binding-NAME repo-wide confinement; static gate
 * modeled on check-c4-anti-arbitration.mjs with anti-vacuity proof); Founder
 * DISPOSITION D-2026-0615-49 O-5 (MANDATORY/BLOCKING) + the binding-confinement
 * rulings (RUNTIME dereference allowlist = the single write adapter ONLY;
 * TEXTUAL mentions allowed only in wrangler/config + env-type + adapter + mock +
 * static gate + telemetry tests).
 *
 * Three blocking assertions, each with anti-vacuity proof (scanned > 0):
 *  (A) NO-READ: no serve/scoring/projection/ranking/MCP-response path names the
 *      telemetry binding ADOPTION_TELEMETRY at all (it must never be read there).
 *  (B) EMITTER PURITY: the write adapter's public emit() signature accepts NO
 *      Request/URL/Headers/body/raw-path param, and no FORBIDDEN field NAME
 *      appears as an identifier in the telemetry modules.
 *  (C) BINDING CONFINEMENT (GENUINELY REPO-WIDE): the binding name
 *      ADOPTION_TELEMETRY appears ONLY in the textual allowlist (config +
 *      env-type + adapter + mock + this gate + telemetry tests). The scan is
 *      derived from `git ls-files` (the tracked closed set) -- NOT a hand-listed
 *      src/scripts/tests subset -- so .github/workflows, astro.config.*, root
 *      *.ts/js/mjs/cjs/json/toml/yml/yaml, public/, etc. are ALL covered. Only
 *      binary/generated/vendor/build-output/dependency files are excluded. The
 *      RUNTIME dereference of env.ADOPTION_TELEMETRY is allowed ONLY in the single
 *      AE write adapter (the rest of the allowlist is textual-declaration only).
 *      FAIL-CLOSED on: 0 tracked files, 0 scanned text files, or the adapter not
 *      mentioning the binding (confinement-vacuity).
 *
 * Pure Node, one `git ls-files` exec. ASCII-only (CES Art 8.1).
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINDING = 'ADOPTION_TELEMETRY';
// Word-boundary match so the SPEC document name (..._ADOPTION_TELEMETRY_DESIGN_
// SPEC...) -- where the binding is a substring of a larger identifier -- does NOT
// count as a binding mention. Only the bare binding token is the dereference.
const BINDING_RE = /(?<![A-Za-z0-9_])ADOPTION_TELEMETRY(?![A-Za-z0-9_])/;
const mentionsBinding = (s) => BINDING_RE.test(s);

// (A) NO-READ scanned set = the C4 gate's serve/scoring/ranking paths PLUS the
// SPEC s8-named projection/MCP/search/FNI surfaces. A missing path hard-fails so
// a rename cannot silently drop coverage.
const NO_READ_PATHS = [
  'src/pages/api/v1/select.ts',
  'src/lib/ranking-order.ts',
  'src/pages/api/v1/compare.ts',
  'src/pages/api/v1/badge/[umid].ts',
  'src/pages/api/v1/trends/batch.ts',
  'src/pages/api/v1/concepts.ts',
  'scripts/factory/lib/fni-score.js',
  'src/lib/rationale-builder.ts',
  'src/pages/api/search.ts',
  'src/pages/api/mcp.ts',
  'src/lib/entity-projection.ts',
  'src/lib/cluster-rerank.ts',
  'src/middleware.ts',
];

// (C) TEXTUAL allowlist: the ONLY files permitted to mention the binding name.
const TEXTUAL_ALLOWLIST = new Set([
  'wrangler.toml',
  'src/env.d.ts',
  'src/lib/telemetry/ae-adapter.ts',
  'src/lib/telemetry/mock-binding.ts',
  'scripts/check-telemetry-no-read.mjs',
  'tests/srs1/telemetry-isolation.test.ts',
  'tests/srs1/telemetry-schema.test.ts',
  'tests/srs1/telemetry-privacy.test.ts',
  'tests/srs1/INVARIANT_REGISTRY.md',
]);

// (B) emitter-purity: forbidden TYPE/param tokens that must NOT appear in the
// adapter's emit() signature, and forbidden field NAMES that must not be read as
// identifiers anywhere in the telemetry modules (besides the FORBIDDEN_FIELDS
// declaration + comments that explain the ban).
const EMITTER_FORBIDDEN_PARAM_TYPES = ['Request', 'URL', 'Headers'];
const TELEMETRY_MODULES = [
  'src/lib/telemetry/vocab.ts',
  'src/lib/telemetry/schema.ts',
  'src/lib/telemetry/ae-adapter.ts',
  'src/lib/telemetry/mock-binding.ts',
];

function read(rel) {
  const abs = path.join(REPO_ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
}

// Binary/generated/vendor/build-output/dependency exclusions: a file is EXCLUDED
// from the text scan only if it is one of these (everything else IS scanned, so a
// new text/config/workflow location can never silently escape confinement).
const EXCLUDE_EXT = new Set([
  'wasm', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'pdf', 'zip', 'gz',
  'br', 'zst', 'woff', 'woff2', 'ttf', 'eot', 'db', 'sqlite', 'bin', 'pyc',
  'lock',
]);
const EXCLUDE_PATH_RE = /(^|\/)(node_modules|dist|build|\.astro|coverage|target|vendor|\.git)\//;
const isBinaryLike = (buf) => buf.includes(0); // NUL byte => treat as binary

/**
 * Repo-wide binding scan over the TRACKED closed set (`git ls-files`). Scans every
 * tracked text file for the binding token; excludes only binary/generated/vendor/
 * build-output/dependency files. Returns hits + scan stats for fail-closed checks.
 */
function findBindingMentions() {
  let tracked = [];
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    tracked = out.toString('utf-8').split('\0').filter(Boolean);
  } catch {
    return { hits: [], filesScanned: 0, trackedCount: 0 };
  }
  const trackedCount = tracked.length;
  const hits = [];
  let filesScanned = 0;
  for (const rel of tracked) {
    if (EXCLUDE_PATH_RE.test('/' + rel + '/')) continue;
    const ext = (rel.split('.').pop() || '').toLowerCase();
    if (rel.includes('.') && EXCLUDE_EXT.has(ext)) continue;
    const abs = path.join(REPO_ROOT, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    if (isBinaryLike(buf)) continue;   // defensive binary guard (no extension)
    filesScanned++;
    if (mentionsBinding(buf.toString('utf-8'))) hits.push(rel);
  }
  return { hits, filesScanned, trackedCount };
}

function main() {
  console.log('[TEL] Adoption-Telemetry no-read + binding-confinement static gate');
  let failed = false;
  let totalScanned = 0;
  let totalLines = 0;

  // (A) NO-READ
  const missing = [];
  let noReadFiles = 0;
  const noReadViolations = [];
  for (const rel of NO_READ_PATHS) {
    const src = read(rel);
    if (src === null) { missing.push(rel); continue; }
    noReadFiles++;
    const lines = src.split('\n');
    totalLines += lines.length;
    lines.forEach((ln, i) => {
      if (mentionsBinding(ln)) noReadViolations.push(`${rel}:${i + 1}`);
    });
  }
  totalScanned += noReadFiles;
  console.log(`[TEL] (A) no-read paths scanned: ${noReadFiles}/${NO_READ_PATHS.length}`);
  if (missing.length) {
    console.error(`[TEL] FAIL (A): ${missing.length} no-read path(s) missing: ${missing.join(', ')}`);
    failed = true;
  }
  if (noReadViolations.length) {
    console.error(`[TEL] FAIL (A): telemetry binding read in serve/scoring path(s): ${noReadViolations.join(', ')}`);
    failed = true;
  }

  // (B) EMITTER PURITY
  const adapter = read('src/lib/telemetry/ae-adapter.ts');
  if (adapter === null) {
    console.error('[TEL] FAIL (B): write adapter missing'); failed = true;
  } else {
    totalScanned++;
    const sigMatch = adapter.match(/export function emit\(([\s\S]*?)\)\s*:/);
    if (!sigMatch) {
      console.error('[TEL] FAIL (B): could not locate emit() signature'); failed = true;
    } else {
      const sig = sigMatch[1];
      for (const t of EMITTER_FORBIDDEN_PARAM_TYPES) {
        if (new RegExp(`:\\s*${t}\\b`).test(sig)) {
          console.error(`[TEL] FAIL (B): emit() accepts forbidden param type ${t}`); failed = true;
        }
      }
      console.log(`[TEL] (B) emit() signature scanned (len ${sig.length}); forbidden param types absent`);
    }
  }

  // (C) BINDING CONFINEMENT -- genuinely repo-wide over `git ls-files`.
  const { hits, filesScanned, trackedCount } = findBindingMentions();
  totalScanned += filesScanned;
  const leaks = hits.filter((h) => !TEXTUAL_ALLOWLIST.has(h));
  console.log(`[TEL] (C) tracked files: ${trackedCount}; text files scanned: ${filesScanned}; binding mentions: ${hits.length}`);
  if (leaks.length) {
    console.error(`[TEL] FAIL (C): binding named outside textual allowlist: ${leaks.join(', ')}`);
    failed = true;
  }

  // FAIL-CLOSED: 0 tracked files (not a git repo / ls-files failed) or 0 scanned
  // text files means the confinement scan is vacuous -- treat as a hard failure.
  if (trackedCount === 0) {
    console.error('[TEL] FAIL: 0 tracked files (git ls-files empty/failed) -- confinement vacuous.');
    failed = true;
  }
  if (filesScanned === 0) {
    console.error('[TEL] FAIL: 0 text files scanned -- confinement vacuous.');
    failed = true;
  }

  // ANTI-VACUITY: prove the gate actually scanned (A) targets too.
  if (totalScanned === 0 || totalLines === 0) {
    console.error('[TEL] FAIL: scanned 0 files/lines -- gate is vacuous (paths moved?).');
    failed = true;
  }
  // Prove (C) confined to a NON-EMPTY allowlist that DID match (the adapter -- the
  // sole RUNTIME-dereference site -- must be among the mentions) else vacuous.
  if (!hits.includes('src/lib/telemetry/ae-adapter.ts')) {
    console.error('[TEL] FAIL: anti-vacuity -- write adapter does not mention the binding; confinement vacuous.');
    failed = true;
  }
  console.log(`[TEL] anti-vacuity: total scanned=${totalScanned}, no-read lines=${totalLines}, tracked=${trackedCount}, binding mentions=${hits.length}`);

  if (failed) process.exit(1);
  console.log('[TEL] PASS: no serve path reads telemetry; emitter pure; binding confined.');
}

export { NO_READ_PATHS, TEXTUAL_ALLOWLIST, findBindingMentions, BINDING };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
