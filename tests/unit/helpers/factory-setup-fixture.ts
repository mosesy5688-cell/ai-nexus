// tests/unit/helpers/factory-setup-fixture.ts
//
// Shared fixture for WORK ORDER L GROUP B: extracts the composite action's
// "Free Runner Disk" shell script as text and runs it locally with every real
// cleanup command replaced by a bash recorder function.
//
// SIDE EFFECTS: none. `sudo`, `docker`, `apt-get`, `rm` and `df` are all intercepted
// by shell functions defined ahead of the script, so no real cleanup command — and in
// particular no `rm` — is ever executed. `sudo` is intercepted first, so the `rm` it
// would have invoked never runs even as a stub.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { stubGuard, STUB_GUARD_EXIT } from './github-output-records';

export { STUB_GUARD_EXIT };

export const REPO = path.resolve(__dirname, '../../..');
export const ACTION_PATH = '.github/actions/factory-setup/action.yml';
export const action = fs
  .readFileSync(path.join(REPO, ACTION_PATH), 'utf8')
  .replace(/\r\n/g, '\n');

export const EXPR = '${{ inputs.aggressive-disk-cleanup }}';
export const CARRIER = 'AGGRESSIVE_DISK_CLEANUP';
export const AGGRESSIVE_MARK = '/usr/local/graalvm';

// The cleanup scope, pinned byte-for-byte against the pre-fix baseline.
export const BASE_CLEANUP = [
  '        sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/share/boost 2>/dev/null || true',
  '        sudo rm -rf /opt/hostedtoolcache/CodeQL /opt/hostedtoolcache/Python /opt/hostedtoolcache/go /opt/hostedtoolcache/Ruby /opt/hostedtoolcache/node/18* /opt/hostedtoolcache/node/20* 2>/dev/null || true',
  '        sudo rm -rf /usr/local/share/powershell /usr/share/swift /usr/local/.ghcup 2>/dev/null || true'
];
export const AGGRESSIVE_CLEANUP =
  '          sudo rm -rf /usr/local/julia* /usr/local/graalvm /usr/share/miniconda /usr/local/share/chromium /usr/share/az* /opt/microsoft 2>/dev/null || true';
export const TAIL_CLEANUP = [
  '        docker system prune -af 2>/dev/null || true',
  '        sudo apt-get clean 2>/dev/null || true'
];

export function extractFreeDiskRun(src: string): string {
  const stepAt = src.indexOf('    - name: Free Runner Disk\n');
  if (stepAt < 0) throw new Error('Free Runner Disk step not found');
  const rest = src.slice(stepAt);
  const TAG = '\n      run: |\n';
  const runAt = rest.indexOf(TAG);
  if (runAt < 0) throw new Error('run block not found');
  const body = rest.slice(runAt + TAG.length).split('\n');
  const kept: string[] = [];
  for (const l of body) {
    if (l.trim() === '') { kept.push(''); continue; }
    if (!l.startsWith('        ')) break;
    kept.push(l.slice(8));
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n') + '\n';
}

export const FIXED_RUN = extractFreeDiskRun(action);

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

export const STUBBED_TOOLS = ['sudo', 'docker', 'apt-get', 'rm', 'df'];

const STUB_FNS = [
  'sudo()    { printf "SUDO %s\\n" "$*" >> "$REC"; }',
  'docker()  { printf "DOCKER %s\\n" "$*" >> "$REC"; }',
  'apt-get() { printf "APTGET %s\\n" "$*" >> "$REC"; }',
  'rm()      { printf "RM %s\\n" "$*" >> "$REC"; }',
  'df()      { printf "Filesystem Size Used Avail\\n/dev/stub 1G 1G 42G\\n"; }',
  ''
].join('\n');

// FAIL-CLOSED STUB-INTERCEPTION GUARD — see tests/unit/helpers/github-output-records.ts
// for the rationale. These stubs are bash FUNCTIONS, so PATH is never consulted and
// this harness cannot leak a real `sudo`/`docker`/`apt-get`/`rm` through a malformed
// PATH. The guard PROVES that before a single line of the cleanup script runs: every
// name in STUBBED_TOOLS must resolve to a function, or the script aborts with 97.
const STUBS = STUB_FNS + stubGuard(STUBBED_TOOLS);

// The same guard with NO stubs defined — proves the guard is not vacuous.
export const GUARD_WITHOUT_STUBS = stubGuard(STUBBED_TOOLS);

export type BResult = { rc: number | null; out: string; rec: string };

export function runFreeDisk(
  bash: string,
  script: string,
  env: Record<string, string>,
  prologue: string = STUBS
): BResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-l-b-'));
  const rec = path.join(dir, 'rec.log');
  const sh = path.join(dir, 'step.sh');
  fs.writeFileSync(rec, '');
  fs.writeFileSync(sh, prologue + script);
  const r = spawnSync(bash, ['-e', sh], { encoding: 'utf8', env: { ...process.env, REC: rec, ...env } });
  return {
    rc: r.status,
    out: String(r.stdout || '') + String(r.stderr || ''),
    rec: fs.readFileSync(rec, 'utf8')
  };
}

// Models what the pre-fix line did: the Actions expression engine substitutes the
// input value INTO the shell source before bash ever sees it. Throws if either anchor
// is missing or ambiguous, so a revert can never silently no-op.
export function revertAndInterpolate(value: string): string {
  const fixedLine = `if [ "$${CARRIER}" = "true" ]; then`;
  const preFixLine = `if [ "${EXPR}" = "true" ]; then`;
  const n = FIXED_RUN.split(fixedLine).length - 1;
  if (n !== 1) throw new Error(`revert anchor occurs ${n} times`);
  const reverted = FIXED_RUN.replace(fixedLine, () => preFixLine);
  const m = reverted.split(EXPR).length - 1;
  if (m !== 1) throw new Error(`interpolation anchor occurs ${m} times`);
  return reverted.split(EXPR).join(value);
}

// A payload that, once spliced into the pre-fix line, closes the test and runs a
// command of its own. Inert data once the value travels through step env:.
export const INJECTION_PAYLOAD = 'a" ]; then echo PWNED_MARKER; fi; if [ "z" = "true';
