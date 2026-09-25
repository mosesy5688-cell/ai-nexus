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
  HASH_RECORD_INJECT,
  STUB_GH_ID,
  GUARD_WITHOUT_STUB,
  STUB_GUARD_EXIT
} from './helpers/github-output-records';

const BASH = resolveBash();
const run = (script: string, env: Record<string, string>) => runStep(BASH, script, env);
// A-2 POSITION SWEEP ("refuse CR or LF before writing"). CR, LF, CR+'id=202' and
// LF+'id=202' are each inserted at EVERY position 0..11 of the 11-digit id
// '12345678901' (the length of real run ids): 12 x 4 = 48 generated inputs per step.
const SWEEP_ID = '12345678901';
const SWEEP_INSERTS = ['\r', '\n', '\rid=202', '\nid=202'];
const SWEEP: string[] = [];
for (let pos = 0; pos <= SWEEP_ID.length; pos++) {
  for (const ins of SWEEP_INSERTS) SWEEP.push(SWEEP_ID.slice(0, pos) + ins + SWEEP_ID.slice(pos));
}

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
    it(`${label}: CR/LF POSITION SWEEP -- every generated input is refused with a 0-byte output`, () => {
      expect(SWEEP.length, 'sweep size: 12 positions x 4 inserts').toBe(48);
      for (const v of SWEEP) {
        const r = run(script, { [envKey]: v });
        const tag = `${label} input=${JSON.stringify(v)}`;
        expect(r.rc, `${tag}: step must fail closed`).not.toBe(0);
        expect(r.raw, `${tag}: output file must be 0 bytes`).toBe('');
        expect(r.output, tag).toContain('refusing to write a multi-record GITHUB_OUTPUT');
      }
    }, 180000);

    // Not in the sweep: a two-character CRLF terminator, and a '#'-keyed record.
    const variants: [string, string][] = [
      ['CRLF', CRLF_INJECT],
      ["LF + '#key=value'", HASH_RECORD_INJECT]
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

  it('the empty/null fallback is PRESERVED per slot in image-processor and factory-aggregate', () => {
    for (const v of ['', 'null']) {
      const img = run(IMAGE_STEP, { INPUT_AGGREGATE_RUN_ID: v });
      expect(img.rc, `image value=${JSON.stringify(v)}`).toBe(0);
      expect(img.ghCalled).toBe(true);
      expect(img.records).toEqual([{ key: 'id', value: STUB_GH_ID }]);
      const agg = run(AGGREGATE_STEP, { INPUT_PROCESS_RUN_ID: v });
      expect(agg.rc, `aggregate value=${JSON.stringify(v)}`).toBe(0);
      expect(agg.records).toEqual([
        { key: 'harvest-id', value: STUB_GH_ID },
        { key: 'process-id', value: STUB_GH_ID }
      ]);
    }
  });

  // A-3 CONTROL SET: the gate constrains CR/LF ONLY. Every non-CR/LF value below must
  // be ACCEPTED by all three steps and written BYTE-FOR-BYTE (no trim, strip, rewrite).
  const ACCEPT = [
    'a\tb', '1 2', ' 101', '101 ', '#101', '1=2', 'a b-c_D.9', 'é✓', '1\u000b2', '1\u000c2',
    '1\u001b2', '1\u00852', '1 2', '1"2', '1\\2', '1*2', '$(echo X)', '9'.repeat(40)
  ];
  const ACCEPT_CASES: [string, string, string, (v: string) => string][] = [
    ['factory-upload', UPLOAD_STEP, 'INPUT_AGGREGATE_RUN_ID', (v) => `id=${v}\n`],
    ['image-processor', IMAGE_STEP, 'INPUT_AGGREGATE_RUN_ID', (v) => `id=${v}\n`],
    ['factory-aggregate', AGGREGATE_STEP, 'INPUT_PROCESS_RUN_ID', (v) => `harvest-id=${STUB_GH_ID}\nprocess-id=${v}\n`]
  ];
  for (const [label, script, envKey, expected] of ACCEPT_CASES) {
    it(`${label}: every non-CR/LF control value is ACCEPTED and written byte-for-byte`, () => {
      for (const v of ACCEPT) {
        const r = run(script, { [envKey]: v });
        expect(r.rc, `${label} ${JSON.stringify(v)}: must be accepted`).toBe(0);
        expect(r.raw, `${label} ${JSON.stringify(v)}: byte-for-byte`).toBe(expected(v));
      }
    }, 120000);
  }
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
  // CRLF is counted through the parser MODEL's one-trailing-CR drop (PARSER_FIDELITY
  // item 4); it shows the extra record reappears, not how a runner reads CR.
  const payloads: [string, string][] = [['LF', LF_INJECT], ['CRLF', CRLF_INJECT]];
  for (const [label, script, envKey, expected] of reverts) {
    for (const [pname, payload] of payloads) {
      it(`${label}: reverted script + ${pname} payload exits 0 and writes ${expected} records`, () => {
        const r = run(revertGate(script), { [envKey]: payload });
        expect(r.rc, 'the pre-fix behaviour is a NORMAL exit').toBe(0);
        expect(r.records.length).toBe(expected);
        expect(r.records.some((x) => x.value === '202')).toBe(true);
      });
    }
  }

  // L-G1-01 in the verification object itself: the pre-fix script writes 'id=101'
  // and then a '#key=value' line. The corrected parser counts that injected line as
  // a record; the superseded '#'-skipping parser counted only one.
  for (const [label, script, envKey, expected] of reverts) {
    it(`${label}: reverted script + '#key=value' payload writes ${expected} records`, () => {
      const r = run(revertGate(script), { [envKey]: HASH_RECORD_INJECT });
      expect(r.rc).toBe(0);
      expect(r.records.length).toBe(expected);
      expect(r.records.some((x) => x.key === '#key' && x.value === 'value')).toBe(true);
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
