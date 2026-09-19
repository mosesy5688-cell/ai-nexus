// tests/unit/factory-setup-input-interpolation.test.ts
//
// WORK ORDER L — GROUP B (static half): .github/actions/factory-setup/action.yml.
// Behaviour runs live in tests/unit/factory-setup-cleanup-behaviour.test.ts.
//
// WHAT THIS LOCKS
//   The composite action's "Free Runner Disk" step used to splice the input straight
//   into its shell source:
//       if [ "${{ inputs.aggressive-disk-cleanup }}" = "true" ]; then
//   The COMPLETE original expression now lives in the step's `env:` and the condition
//   compares the referenced variable against the LITERAL `true`. The `false` input
//   default, the condition itself and the cleanup scope are unchanged.
//
// WHAT THIS DOES *NOT* CLAIM
//   This is structural-risk removal. No escalation via this entry point was ever
//   demonstrated: every caller in the repo passes a quoted YAML literal (asserted
//   below), and nothing here changes work order H Ledger B's 0/12 NOT PROVEN status.
//   A composite action is checked HERE — a `jobs.steps.run` sweep of workflows does
//   not cover it — and "the repo has secrets somewhere" does not imply this entry
//   point receives any.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  REPO,
  action,
  EXPR,
  CARRIER,
  FIXED_RUN,
  BASE_CLEANUP,
  AGGRESSIVE_CLEANUP,
  TAIL_CLEANUP
} from './helpers/factory-setup-fixture';

describe('GROUP B-0/B-1 — the input is no longer interpolated into shell source', () => {
  it('the step carries the COMPLETE original expression in env:', () => {
    expect(action).toContain(`        ${CARRIER}: ${EXPR}\n`);
  });

  it('the condition compares the referenced variable against the literal `true`', () => {
    expect(action).toContain(`        if [ "$${CARRIER}" = "true" ]; then\n`);
  });

  it('no shell line in the step interpolates ANY expression', () => {
    expect(FIXED_RUN.includes(EXPR), 'input spliced into shell source').toBe(false);
    expect(FIXED_RUN.includes('${{'), 'any expression left in shell source').toBe(false);
    // the whole composite has exactly two remaining `${{ }}` uses, both OUTSIDE any
    // shell script: the env: carrier and the actions/cache key.
    expect(action.split('${{').length - 1).toBe(2);
    expect(action).toContain(
      "        key: rust-ffi-v3-${{ hashFiles('rust/Cargo.toml', 'rust/*/Cargo.toml', 'rust/*/src/**') }}\n"
    );
  });

  it('the `false` input default is preserved', () => {
    const at = action.indexOf('  aggressive-disk-cleanup:');
    expect(at).toBeGreaterThanOrEqual(0);
    const block = action.slice(at, action.indexOf('  with-rust-ffi:'));
    expect(block).toContain('    required: false\n');
    expect(block).toContain("    default: 'false'\n");
  });

  it('the cleanup scope is unchanged and NOT widened', () => {
    for (const line of [...BASE_CLEANUP, AGGRESSIVE_CLEANUP, ...TAIL_CLEANUP]) {
      expect(action).toContain(line + '\n');
    }
    // exactly four `sudo rm -rf` invocations — three base, one aggressive.
    expect(action.split('sudo rm -rf').length - 1).toBe(4);
    // the aggressive removal stays inside the conditional branch.
    const ifAt = action.indexOf(`        if [ "$${CARRIER}" = "true" ]; then\n`);
    const aggAt = action.indexOf(AGGRESSIVE_CLEANUP);
    const fiAt = action.indexOf('\n        fi\n', ifAt);
    expect(ifAt).toBeLessThan(aggAt);
    expect(aggAt).toBeLessThan(fiAt);
  });

  it('permissions and triggers are untouched (a composite action declares none)', () => {
    expect(action.includes('permissions:')).toBe(false);
    expect(action.includes('\non:\n')).toBe(false);
    expect(action).toContain('  using: composite\n');
  });

  it('with-rust-ffi is left alone — it is an `if:` expression, not shell source', () => {
    expect(action).toContain("      if: inputs.with-rust-ffi == 'true'\n");
  });
});

describe('GROUP B-2 — every caller passes a CONSTANT, not an input or other context', () => {
  const wfDir = path.join(REPO, '.github/workflows');
  const files = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  const sites: { file: string; line: number; value: string }[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(wfDir, f), 'utf8').replace(/\r\n/g, '\n').split('\n');
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('aggressive-disk-cleanup:')) {
        sites.push({ file: f, line: i + 1, value: t.slice('aggressive-disk-cleanup:'.length).trim() });
      }
    });
  }

  it('the census is non-empty (a zero-hit sweep would prove nothing)', () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it('every call site passes a quoted literal true/false — no expression, no input', () => {
    for (const s of sites) {
      expect(["'true'", "'false'"], `${s.file}:${s.line} passes ${s.value}`).toContain(s.value);
    }
  });

  it('no call site forwards a secret, a workflow input, or any other context', () => {
    for (const s of sites) {
      expect(s.value.includes('${{'), `${s.file}:${s.line}`).toBe(false);
      expect(s.value.includes('secrets.'), `${s.file}:${s.line}`).toBe(false);
      expect(s.value.includes('inputs.'), `${s.file}:${s.line}`).toBe(false);
    }
  });

  it('the number of call sites matches the number of `uses:` references', () => {
    let uses = 0;
    for (const f of files) {
      const txt = fs.readFileSync(path.join(wfDir, f), 'utf8');
      uses += txt.split('uses: ./.github/actions/factory-setup').length - 1;
    }
    expect(sites.length).toBe(uses);
  });

  it('the composite receives no secrets of its own (it declares only two inputs)', () => {
    const inputsBlock = action.slice(action.indexOf('inputs:'), action.indexOf('runs:'));
    expect(inputsBlock).toContain('  aggressive-disk-cleanup:');
    expect(inputsBlock).toContain('  with-rust-ffi:');
    expect(inputsBlock.includes('secrets')).toBe(false);
    expect(action.includes('${{ secrets.')).toBe(false);
  });
});
