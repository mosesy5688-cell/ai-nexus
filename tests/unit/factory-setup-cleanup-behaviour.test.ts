// tests/unit/factory-setup-cleanup-behaviour.test.ts
//
// WORK ORDER L — GROUP B (behaviour half): B-3. The composite action's
// "Free Runner Disk" script is extracted verbatim and executed against a LOCAL
// fixture with every real cleanup command replaced by a bash recorder function.
// `sudo`, `docker`, `apt-get`, `rm` and `df` never execute for real — `sudo` is
// intercepted first, so the `rm` it would have invoked never runs even as a stub.
//
// Static locks live in tests/unit/factory-setup-input-interpolation.test.ts; the
// extraction, stubs and revert model live in tests/unit/helpers/factory-setup-fixture.ts.
//
// The "reverted" cases model the Actions expression engine splicing the input value
// into the shell source, which is exactly what the pre-fix line did. They demonstrate
// that the fix is load-bearing in a LOCAL model. They are NOT a demonstration of a
// real escalation through this entry point, they claim none, and they do not change
// work order H Ledger B's 0/12 NOT PROVEN status.
import { describe, it, expect } from 'vitest';
import {
  resolveBash,
  runFreeDisk,
  revertAndInterpolate,
  FIXED_RUN,
  CARRIER,
  AGGRESSIVE_MARK,
  INJECTION_PAYLOAD,
  STUBBED_TOOLS,
  GUARD_WITHOUT_STUBS,
  STUB_GUARD_EXIT
} from './helpers/factory-setup-fixture';

const BASH = resolveBash();
const run = (script: string, env: Record<string, string>) => runFreeDisk(BASH, script, env);

// Nothing below is trustworthy unless every cleanup command is actually intercepted.
// These run FIRST and fail closed — a real `sudo rm -rf` escaping this harness would
// wipe the machine it runs on, so "the tests were green" is not acceptable evidence
// on its own.
describe('GROUP B — stub interception is PROVEN before any cleanup line runs', () => {
  it('every stubbed tool resolves to a function inside the harness', () => {
    const probe = STUBBED_TOOLS.map(
      (t) => `printf "%s=%s/%s\\n" "${t}" "$(command -v ${t})" "$(type -t ${t})"`
    ).join('\n');
    const r = run(probe + '\n', {});
    expect(r.rc, 'guarded prologue must not abort').toBe(0);
    for (const t of STUBBED_TOOLS) {
      expect(r.out, `${t} must be intercepted`).toContain(`${t}=${t}/function`);
    }
  });

  it('the guard is NOT vacuous — with no stubs defined it aborts and runs nothing', () => {
    const r = runFreeDisk(BASH, 'echo SHOULD_NEVER_RUN\n', {}, GUARD_WITHOUT_STUBS);
    expect(r.rc, 'guard must fail closed').toBe(STUB_GUARD_EXIT);
    expect(r.out).toContain('STUB_GUARD_FAILED');
    expect(r.out, 'the guarded script body must never execute').not.toContain('SHOULD_NEVER_RUN');
  });
});

describe('GROUP B-3 — no real cleanup command is reachable from the fixture', () => {
  it('every command in the extracted script is one this fixture intercepts', () => {
    for (const line of FIXED_RUN.split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const ok =
        /^\s*(sudo|docker)\b/.test(line) ||
        /^\s*(if|fi|echo)\b/.test(line) ||
        line.includes('$(df ');
      expect(ok, `unstubbed command reachable: ${line}`).toBe(true);
    }
    expect(FIXED_RUN.includes('curl')).toBe(false);
    expect(FIXED_RUN.includes('wget')).toBe(false);
  });
});

describe('GROUP B-3 — the true/false normal branches', () => {
  it('true  -> the aggressive branch runs (recorded, never executed)', () => {
    const r = run(FIXED_RUN, { [CARRIER]: 'true' });
    expect(r.rc).toBe(0);
    expect(r.rec).toContain(AGGRESSIVE_MARK);
    expect(r.rec).toContain('DOCKER system prune -af');
    expect(r.rec, 'sudo intercepts rm; real rm must never be reached').not.toContain('\nRM ');
  });

  it('false -> the aggressive branch does NOT run, base cleanup still does', () => {
    const r = run(FIXED_RUN, { [CARRIER]: 'false' });
    expect(r.rc).toBe(0);
    expect(r.rec).not.toContain(AGGRESSIVE_MARK);
    expect(r.rec).toContain('/usr/share/dotnet');
    expect(r.rec).toContain('DOCKER system prune -af');
  });

  it('unset (the `false` default path) -> the aggressive branch does NOT run', () => {
    const r = run(FIXED_RUN, { [CARRIER]: '' });
    expect(r.rc).toBe(0);
    expect(r.rec).not.toContain(AGGRESSIVE_MARK);
    expect(r.rec).toContain('/usr/share/dotnet');
  });
});

describe('GROUP B-3 — special text executes no command', () => {
  it('a branch-closing payload is inert data', () => {
    const r = run(FIXED_RUN, { [CARRIER]: INJECTION_PAYLOAD });
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain('PWNED_MARKER');
    expect(r.rec).not.toContain(AGGRESSIVE_MARK);
    expect(r.rec).not.toContain('PWNED');
  });

  it('newline-bearing text is inert data too', () => {
    const r = run(FIXED_RUN, { [CARRIER]: 'false\necho PWNED_MARKER' });
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain('PWNED_MARKER');
    expect(r.rec).not.toContain(AGGRESSIVE_MARK);
  });

  it('a command-substitution payload is inert data too', () => {
    const r = run(FIXED_RUN, { [CARRIER]: '$(echo PWNED_MARKER)' });
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain('PWNED_MARKER');
    expect(r.rec).not.toContain(AGGRESSIVE_MARK);
  });
});

describe('GROUP B-3 — reverting the site turns the test red', () => {
  it('reverted + special text DOES execute an injected command (fix is load-bearing)', () => {
    const r = run(revertAndInterpolate(INJECTION_PAYLOAD), {});
    expect(r.out, 'the pre-fix line splices the value into shell source').toContain('PWNED_MARKER');
  });

  it('reverted + plain true behaves exactly as the fixed version (no behaviour change)', () => {
    const rev = run(revertAndInterpolate('true'), {});
    const fix = run(FIXED_RUN, { [CARRIER]: 'true' });
    expect(rev.rec).toBe(fix.rec);
    expect(rev.rc).toBe(fix.rc);
  });

  it('reverted + plain false behaves exactly as the fixed version', () => {
    const rev = run(revertAndInterpolate('false'), {});
    const fix = run(FIXED_RUN, { [CARRIER]: 'false' });
    expect(rev.rec).toBe(fix.rec);
    expect(rev.rc).toBe(fix.rc);
  });
});
