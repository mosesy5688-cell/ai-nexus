// tests/unit/workflow-output-record-behaviour.test.ts
//
// WORK ORDER L — GROUP A (behaviour half): A-4 ①②③④ verified at the RECORD-PARSING
// layer. The step scripts are extracted verbatim from the workflows and executed
// locally with `gh` replaced by a bash function — no network, no `gh` binary, no
// GitHub runner. Static invariants live in workflow-output-record-integrity.test.ts;
// the pinned parser and its fidelity statement live in
// tests/unit/helpers/github-output-records.ts.
//
// This proves record COUNT and record KEY/VALUE only. It asserts nothing about the
// hosted runner's final acceptance or duplicate-key override order, claims no proven
// escalation, and does not change work order H Ledger B's 0/12 NOT PROVEN status.
import { describe, it, expect } from 'vitest';
import {
  resolveBash,
  runStep,
  revertGate,
  UPLOAD_STEP,
  IMAGE_STEP,
  AGGREGATE_STEP,
  LF_INJECT,
  CRLF_INJECT,
  CR_ONLY,
  STUB_GH_ID,
  GUARD_WITHOUT_STUB,
  STUB_GUARD_EXIT
} from './helpers/github-output-records';

const BASH = resolveBash();
const run = (script: string, env: Record<string, string>) => runStep(BASH, script, env);

// Nothing below is trustworthy unless the stub actually owns the name `gh`. These run
// FIRST and fail closed. (A sibling harness elsewhere built PATH from a Windows
// drive-letter path, PATH split on the ':', the stub was never found, and real
// requests escaped to production. This harness uses bash FUNCTIONS, never PATH — and
// now proves it instead of assuming it.)
describe('GROUP A — stub interception is PROVEN before anything runs', () => {
  it('inside the harness, `gh` resolves to the stub function, not a binary', () => {
    const r = run('printf "resolved=%s type=%s\\n" "$(command -v gh)" "$(type -t gh)"\n', {});
    expect(r.rc, 'guarded prologue must not abort').toBe(0);
    expect(r.output).toContain('resolved=gh');
    expect(r.output).toContain('type=function');
  });

  it('the guard is NOT vacuous — with no stub defined it aborts and runs nothing', () => {
    const r = runStep(BASH, 'echo SHOULD_NEVER_RUN\n', {}, GUARD_WITHOUT_STUB);
    expect(r.rc, 'guard must fail closed').toBe(STUB_GUARD_EXIT);
    expect(r.output).toContain('STUB_GUARD_FAILED');
    expect(r.output, 'the guarded script body must never execute').not.toContain('SHOULD_NEVER_RUN');
  });

  it('no real `gh` is reachable: the stub id is a sentinel a real binary cannot return', () => {
    const r = run(UPLOAD_STEP, { INPUT_AGGREGATE_RUN_ID: '' });
    expect(r.ghCalled).toBe(true);
    expect(r.records).toEqual([{ key: 'id', value: STUB_GH_ID }]);
  });
});

const CASES: [string, string, string][] = [
  ['factory-upload Get ID', UPLOAD_STEP, 'INPUT_AGGREGATE_RUN_ID'],
  ['image-processor Get ID', IMAGE_STEP, 'INPUT_AGGREGATE_RUN_ID'],
  ['factory-aggregate Get Run IDs', AGGREGATE_STEP, 'INPUT_PROCESS_RUN_ID']
];

describe('GROUP A-4 ① — LF / CRLF / duplicate-key text cannot ADD a record', () => {
  for (const [label, script, envKey] of CASES) {
    const variants: [string, string][] = [
      ['LF', LF_INJECT],
      ['CRLF', CRLF_INJECT],
      ['lone CR', CR_ONLY]
    ];
    for (const [name, value] of variants) {
      it(`${label}: ${name} injection is refused and writes NOTHING`, () => {
        const r = run(script, { [envKey]: value });
        expect(r.rc, 'step must fail closed').not.toBe(0);
        expect(r.raw, 'no partially valid output may remain').toBe('');
        expect(r.records).toEqual([]);
        expect(r.output).toContain('refusing to write a multi-record GITHUB_OUTPUT');
      });
    }
  }

  it('factory-aggregate: a duplicate harvest-id record cannot be added', () => {
    const r = run(AGGREGATE_STEP, { INPUT_PROCESS_RUN_ID: '101\nharvest-id=999' });
    expect(r.rc).not.toBe(0);
    expect(r.raw).toBe('');
    expect(r.records).toEqual([]);
  });
});

describe('GROUP A-4 ② — valid values parse to the SAME key/value as the original contract', () => {
  it('factory-upload: a plain run id yields exactly one id record', () => {
    const r = run(UPLOAD_STEP, { INPUT_AGGREGATE_RUN_ID: '12345678901' });
    expect(r.rc).toBe(0);
    expect(r.records).toEqual([{ key: 'id', value: '12345678901' }]);
    expect(r.ghCalled, 'fallback must not run for a present value').toBe(false);
  });

  it('image-processor: a plain run id yields exactly one id record', () => {
    const r = run(IMAGE_STEP, { INPUT_AGGREGATE_RUN_ID: '12345678901' });
    expect(r.rc).toBe(0);
    expect(r.records).toEqual([{ key: 'id', value: '12345678901' }]);
  });

  it('factory-aggregate: both ids are written, in the original order', () => {
    const r = run(AGGREGATE_STEP, { INPUT_PROCESS_RUN_ID: '222' });
    expect(r.rc).toBe(0);
    expect(r.records).toEqual([
      { key: 'harvest-id', value: STUB_GH_ID },
      { key: 'process-id', value: '222' }
    ]);
  });

  it('the empty/null fallback is PRESERVED — it still runs and still yields one record', () => {
    for (const v of ['', 'null']) {
      const r = run(UPLOAD_STEP, { INPUT_AGGREGATE_RUN_ID: v });
      expect(r.rc, `value=${JSON.stringify(v)}`).toBe(0);
      expect(r.ghCalled, `value=${JSON.stringify(v)} must take the fallback`).toBe(true);
      expect(r.records).toEqual([{ key: 'id', value: STUB_GH_ID }]);
    }
  });

  it('the gate constrains CR/LF ONLY — other characters pass through unmodified', () => {
    // A space-bearing value is not a record-integrity problem. It must still pass and
    // must NOT be trimmed, stripped or rewritten by the gate.
    const r = run(UPLOAD_STEP, { INPUT_AGGREGATE_RUN_ID: 'a b-c_D.9' });
    expect(r.rc).toBe(0);
    expect(r.records).toEqual([{ key: 'id', value: 'a b-c_D.9' }]);
  });
});

describe('GROUP A-4 ③ — a refusal leaves no partially usable identity', () => {
  it('factory-aggregate writes NEITHER id when only one of them is bad', () => {
    const bad = run(AGGREGATE_STEP, { INPUT_PROCESS_RUN_ID: '101\nprocess-id=999' });
    expect(bad.raw).toBe('');
    // control: the same script with a good value DOES write harvest-id, so the
    // emptiness above is the gate's doing and not a broken fixture.
    const good = run(AGGREGATE_STEP, { INPUT_PROCESS_RUN_ID: '101' });
    expect(good.records.map((x) => x.key)).toEqual(['harvest-id', 'process-id']);
  });

  it('a refusal never degrades to the "latest" lookup', () => {
    const r = run(UPLOAD_STEP, { INPUT_AGGREGATE_RUN_ID: '\n' });
    expect(r.rc).not.toBe(0);
    expect(r.ghCalled, 'a rejected value must NOT fall through to the latest-run lookup').toBe(false);
    expect(r.raw).toBe('');
  });
});

describe('GROUP A-4 ④ — reverting the fix makes the counterexample reappear', () => {
  const reverts: [string, string, string, number][] = [
    ['factory-upload Get ID', UPLOAD_STEP, 'INPUT_AGGREGATE_RUN_ID', 2],
    ['image-processor Get ID', IMAGE_STEP, 'INPUT_AGGREGATE_RUN_ID', 2],
    ['factory-aggregate Get Run IDs', AGGREGATE_STEP, 'INPUT_PROCESS_RUN_ID', 3]
  ];
  for (const [label, script, envKey, expected] of reverts) {
    it(`${label}: reverted script exits 0 and writes ${expected} records`, () => {
      const r = run(revertGate(script), { [envKey]: LF_INJECT });
      expect(r.rc, 'the pre-fix behaviour is a NORMAL exit').toBe(0);
      expect(r.records.length).toBe(expected);
      expect(r.records.some((x) => x.value === '202')).toBe(true);
    });
  }

  it('reverted factory-aggregate emits a SECOND harvest-id record', () => {
    const r = run(revertGate(AGGREGATE_STEP), { INPUT_PROCESS_RUN_ID: '101\nharvest-id=999' });
    expect(r.rc).toBe(0);
    expect(r.records.filter((x) => x.key === 'harvest-id').length).toBe(2);
  });

  it('reverted scripts still behave identically for VALID values (no behaviour change)', () => {
    for (const [, script, envKey] of reverts) {
      const fixed = run(script, { [envKey]: '4242' });
      const reverted = run(revertGate(script), { [envKey]: '4242' });
      expect(reverted.records).toEqual(fixed.records);
      expect(reverted.rc).toBe(fixed.rc);
    }
  });
});
