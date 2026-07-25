// tests/srs1/rankings-db-wf-fixtures.ts
//
// Shared HERMETIC text fixtures + YAML slicers for the RANKINGS-DB AUTHORITY invariant
// suites. NOT a `*.test.ts` file, so vitest does not collect it (same pattern as
// tests/srs1/dx-snippet-extract.ts); it only reads repo SOURCE/CONFIG as TEXT
// (CRLF-normalized). NO network, NO workflow execution, NO YAML dependency, and it
// re-implements NO product logic.
//
// Split out so each assertion suite stays under the CES Art 5.1 250-line ceiling:
//   rankings-db-authority-invariant.test.ts            - single source + SEAM_A
//   rankings-db-seam-b-publication-invariant.test.ts   - SEAM_B + the two fail-closed gates
//   rankings-db-verifier-source-invariant.test.ts      - verifier/carrier/exporter source locks
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');
export const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), 'utf8').replace(/\r\n/g, '\n');
export const exists = (rel: string) => fs.existsSync(path.resolve(root, rel));

export const AGG = read('.github/workflows/factory-aggregate.yml');
export const UPL = read('.github/workflows/factory-upload.yml');
export const SUITE = read('.github/workflows/test-suite.yml');
export const CONSTANTS = read('src/constants/rankings-groups.js');
export const FRONTEND_CONSTANTS = read('src/config/constants.ts');
export const EXPORTER = read('scripts/factory/lib/rankings-db-exporter.js');
export const GENERATOR = read('scripts/factory/lib/rankings-generator.js');
export const FINALIZER = read('scripts/factory/lib/pack-finalizer.js');
export const CARRIER = read('scripts/factory/rankings-db-handoff-manifest.mjs');
export const VERIFIER = read('scripts/factory/lib/rankings-db-verifier.js');
export const SELECT = read('src/pages/api/v1/select.ts');

/** Slice the text of one named job (up to the next top-level `  <job>:`). */
export function jobBlock(yml: string, name: string): string {
  const start = yml.indexOf(`\n  ${name}:`);
  if (start < 0) return '';
  const rest = yml.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Slice one named step (up to the next `      - name:` / `      - uses:`), then DROP the
 * trailing comment-only lines: in this repo a step is PRECEDED by its rationale comment,
 * so those trailing lines belong to the NEXT step and would otherwise leak foreign text
 * (e.g. the D-297 capacity comment's own "no `|| true`" phrase) into these assertions.
 */
export function stepBlock(block: string, stepName: string): string {
  const start = block.indexOf(`- name: ${stepName}`);
  if (start < 0) return '';
  const rest = block.slice(start + 1);
  const next = rest.search(/\n {6}- (name|uses):/);
  const lines = (next < 0 ? rest : rest.slice(0, next)).split('\n');
  while (lines.length && /^\s*(#.*)?$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

/** The EXECUTABLE lines of a step (shell/YAML comments stripped) - for ABSENCE assertions. */
export function codeOf(step: string): string {
  return step.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/** The EXECUTABLE lines of a JS/TS source (line comments stripped) - for ABSENCE assertions. */
export function jsCodeOf(src: string): string {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/** Resolve the (job, step) a given workflow line index belongs to. */
export function locate(yml: string, lineIdx: number): { job: string; step: string } {
  const lines = yml.split('\n');
  let job = '?';
  let step = '?';
  for (let i = lineIdx; i >= 0; i -= 1) {
    if (step === '?') {
      const s = /^ {6}- name: (.+)$/.exec(lines[i]);
      if (s) step = s[1].trim();
    }
    const j = /^ {2}([a-z][a-z0-9-]*):$/.exec(lines[i]);
    if (j) { job = j[1]; break; }
  }
  return { job, step };
}

/**
 * DISCOVER every rankings verification INVOCATION across both workflows (comment lines
 * excluded), labelled by workflow :: job :: step :: invocation. Discovery-based on purpose:
 * a NEW call site appears in the result automatically, so a census assertion reds on
 * ADDITION rather than silently tolerating an unflagged new invocation.
 */
export function rankingsVerifySites(): Array<{ label: string; step: string; wf: string; line: string }> {
  const out: Array<{ label: string; step: string; wf: string; line: string }> = [];
  for (const [wf, yml] of [['factory-aggregate.yml', AGG], ['factory-upload.yml', UPL]] as const) {
    yml.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      const inv = /\b(verify-dbs|verify-publication)\s+([^|&;]+)/.exec(line);
      if (!inv) return;
      const { job, step } = locate(yml, i);
      out.push({ label: `${wf} :: ${job} :: ${step} :: ${inv[1]} ${inv[2].trim()}`, step, wf, line: line.trim() });
    });
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

export const AGG_RANKINGS = jobBlock(AGG, 'aggregate-rankings');
export const AGG_FINALIZE = jobBlock(AGG, 'finalize');
export const PACK_JOB = jobBlock(UPL, 'vfs-pack-db');
export const UPLOAD_JOB = jobBlock(UPL, 'upload');

export const SEAM_A_PRODUCER = 'Establish Rankings-Satellite Authority (SEAM_A)';
export const SEAM_A_CONSUMER = 'Consume Rankings-Satellite Authority (SEAM_A, fail-closed)';
export const SEAM_B_PRODUCER = 'Establish Rankings-DB Authority (SEAM_B)';
export const SEAM_B_CONSUMER = 'Promote Rankings DBs from R2 Authority (SEAM_B, fail-closed)';
export const PUB_GATE = 'Rankings-DB Publication Gate (fail-closed, BEFORE any public write)';
export const PUBLISH = 'run: node scripts/factory/r2-upload-s3.js';

/**
 * The EXACT expected group set, declared INDEPENDENTLY of the module under test so a
 * silent edit of src/constants/rankings-groups.js reds the suite (this literal IS the
 * second witness; it is never imported from the constant it verifies).
 */
export const EXPECTED_GROUPS = [
  'all', 'text-generation', 'knowledge-retrieval', 'vision-multimedia',
  'automation-workflow', 'infrastructure-ops', 'model', 'paper', 'dataset', 'tool',
];
