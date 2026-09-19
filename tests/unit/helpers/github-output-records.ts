// tests/unit/helpers/github-output-records.ts
//
// Shared fixture for WORK ORDER L GROUP A: a pinned GITHUB_OUTPUT record parser and
// a local, network-free runner for the Factory "Get ID" step scripts.
//
// PARSER_VERSION is OURS, not GitHub's. It is a TypeScript re-implementation of the
// documented GITHUB_OUTPUT line protocol, modelled on actions/runner
// src/Runner.Worker/FileCommandManager.cs (KeyValueFileData) as documented for the
// v2.3xx runner line.
//
// PARSER_FIDELITY — how this differs from the hosted environment:
//   * It returns the ORDERED LIST OF RECORDS. It deliberately does NOT apply the
//     runner's post-parse SetOutput dictionary write, so it takes NO position on
//     duplicate-key override order — that rule is unverified here by design.
//   * It reproduces: blank-line skip, '#' comment skip, first '=' splits KEY/VALUE,
//     'KEY<<DELIM' heredoc records, and "delimiter not found" / "invalid format" as
//     thrown errors. It does NOT reproduce the runner's exact exception text,
//     container path translation, or any file-size limit.
//   * Line termination: '\n' terminates a line and a single trailing '\r' is dropped.
//     The hosted runner's exact lone-CR handling is NOT verified here. This does not
//     weaken the assertions: the repaired gate rejects CR and LF alike, so both
//     readings give the same accept/reject decision at the write point.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

export const PARSER_VERSION = 'f2ai-github-output-record-parser@1.0.0';
export const REPO = path.resolve(__dirname, '../../..');
export const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8').replace(/\r\n/g, '\n');

export type Rec = { key: string; value: string };

export function parseOutputFile(text: string): Rec[] {
  const out: Rec[] = [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const hd = line.indexOf('<<');
    if (eq >= 0 && (hd < 0 || eq < hd)) {
      out.push({ key: line.slice(0, eq), value: line.slice(eq + 1) });
    } else if (hd >= 0 && (eq < 0 || hd < eq)) {
      const key = line.slice(0, hd);
      const delim = line.slice(hd + 2);
      if (key === '' || delim === '') throw new Error('INVALID_HEREDOC_HEADER');
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const b = lines[j].replace(/\r$/, '');
        if (b === delim) { closed = true; break; }
        body.push(b);
      }
      if (!closed) throw new Error('HEREDOC_DELIMITER_NOT_FOUND');
      out.push({ key, value: body.join('\n') });
      i = j;
    } else {
      throw new Error('INVALID_FORMAT');
    }
  }
  return out;
}

// Text-only step extraction (no YAML dependency — matches the SRS-1 convention).
export function extractRun(yml: string, stepAnchor: string): string {
  const at = yml.indexOf(stepAnchor);
  if (at < 0) throw new Error(`step anchor not found: ${stepAnchor}`);
  const rest = yml.slice(at);
  const TAG = '\n        run: |\n';
  const runAt = rest.indexOf(TAG);
  if (runAt < 0) throw new Error(`run block not found after: ${stepAnchor}`);
  const body = rest.slice(runAt + TAG.length).split('\n');
  const kept: string[] = [];
  for (const l of body) {
    if (l.trim() === '') { kept.push(''); continue; }
    if (!l.startsWith('          ')) break;
    kept.push(l.slice(10));
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n') + '\n';
}

export function resolveBash(): string {
  const candidates =
    process.platform === 'win32'
      ? ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
      : ['/bin/bash', 'bash'];
  for (const c of candidates) {
    const probe = spawnSync(c, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === 'ok') return c;
  }
  throw new Error('no usable bash found — this behaviour suite requires bash (CI runs ubuntu-latest)');
}

// `gh` is replaced by a bash FUNCTION, so no `gh` binary is ever resolved on PATH and
// no network call is possible. It prints a well-formed id wrapped in whitespace so the
// step's original `| tr -d '[:space:]'` still does its original job, and it records
// that it ran so a test can prove whether the empty/null fallback was taken.
const GH_FN = [
  'gh() {',
  '  echo "GH_CALLED" >> "$GH_STUB_LOG"',
  '  printf "  %s  \\n" "$GH_STUB_ID"',
  '}',
  ''
].join('\n');

// FAIL-CLOSED STUB-INTERCEPTION GUARD.
// A bash function shadows PATH lookup entirely, so this harness never builds a PATH
// and is structurally immune to the "Windows drive-letter path split on ':' so the
// stub was never found and real calls escaped" failure mode. That immunity is not
// self-evident from reading the script, so the prologue PROVES it BEFORE the step
// script runs: `command -v` must report the bare name AND `declare -F` must confirm a
// function is bound to it. If either check fails, the script aborts with 97 and
// nothing else executes. Silence is not accepted as success.
export const STUB_GUARD_EXIT = 97;

export function stubGuard(tools: string[]): string {
  return [
    `for __t in ${tools.join(' ')}; do`,
    '  __r=$(command -v "$__t" 2>/dev/null || true)',
    '  if [ "$__r" != "$__t" ] || ! declare -F "$__t" >/dev/null 2>&1; then',
    '    echo "STUB_GUARD_FAILED: $__t resolves to [$__r], not a stub function" >&2',
    `    exit ${STUB_GUARD_EXIT}`,
    '  fi',
    'done',
    ''
  ].join('\n');
}

const GH_STUB = GH_FN + stubGuard(['gh']);

// The same guard with NO stub defined. Used to prove the guard is not vacuous: it
// must abort, which means a green run of the real harness is meaningful.
export const GUARD_WITHOUT_STUB = stubGuard(['gh']);

export const STUB_GH_ID = '777777';

export type RunResult = {
  rc: number | null;
  raw: string;
  records: Rec[];
  ghCalled: boolean;
  output: string;
};

export function runStep(
  bash: string,
  script: string,
  env: Record<string, string>,
  prologue: string = GH_STUB
): RunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-l-a-'));
  const outFile = path.join(dir, 'gh_output');
  const stubLog = path.join(dir, 'gh_stub.log');
  const scriptFile = path.join(dir, 'step.sh');
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(stubLog, '');
  fs.writeFileSync(scriptFile, prologue + script);
  const r = spawnSync(bash, ['-e', scriptFile], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: outFile, GH_STUB_LOG: stubLog, GH_STUB_ID: STUB_GH_ID, ...env }
  });
  const raw = fs.readFileSync(outFile, 'utf8');
  return {
    rc: r.status,
    raw,
    records: parseOutputFile(raw),
    ghCalled: fs.readFileSync(stubLog, 'utf8').includes('GH_CALLED'),
    output: String(r.stdout || '') + String(r.stderr || '')
  };
}

// Revert the fix INSIDE the harness: drop the gate block and restore the original
// unquoted redirect. Throws if nothing was removed, so a revert can never no-op.
export function revertGate(script: string): string {
  const kept: string[] = [];
  let dropped = 0;
  let inGate = false;
  for (const l of script.split('\n')) {
    if (l.includes('# RECORD-INTEGRITY GATE (work order L / A-2)')) { inGate = true; dropped++; continue; }
    if (inGate) {
      dropped++;
      if (l.includes('>> "$GITHUB_OUTPUT"')) {
        inGate = false;
        kept.push(l.replace('>> "$GITHUB_OUTPUT"', '>> $GITHUB_OUTPUT'));
        dropped--;
      }
      continue;
    }
    kept.push(l.replace('>> "$GITHUB_OUTPUT"', '>> $GITHUB_OUTPUT'));
  }
  if (dropped === 0) throw new Error('revertGate() removed nothing — the gate anchor is gone');
  const out = kept.join('\n');
  if (out.includes('RECORD-INTEGRITY GATE')) throw new Error('revertGate() left gate text behind');
  if (out.includes('>> "$GITHUB_OUTPUT"')) throw new Error('revertGate() left a quoted redirect behind');
  return out;
}

export const UPLOAD_WF = '.github/workflows/factory-upload.yml';
export const IMAGE_WF = '.github/workflows/image-processor.yml';
export const AGGREGATE_WF = '.github/workflows/factory-aggregate.yml';

export const uploadYml = read(UPLOAD_WF);
export const imageYml = read(IMAGE_WF);
export const aggregateYml = read(AGGREGATE_WF);

export const UPLOAD_STEP = extractRun(uploadYml, '      - name: Get ID\n        id: get-id\n');
export const IMAGE_STEP = extractRun(imageYml, '      - name: Get ID\n        id: get-id\n');
export const AGGREGATE_STEP = extractRun(
  aggregateYml,
  '      - name: Get Run IDs (Harvest & Process)\n        id: get-ids\n'
);

export const LF_INJECT = '101\nid=202';
export const CRLF_INJECT = '101\r\nid=202';
export const CR_ONLY = '101\r';
export const GATE_MARK = '# RECORD-INTEGRITY GATE (work order L / A-2)';
