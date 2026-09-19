// tests/unit/workflow-output-record-integrity.test.ts
//
// WORK ORDER L — GROUP A (static half): the output-record boundary on the Factory
// "Get ID" input chain. Behaviour/counterexample runs live in
// tests/unit/workflow-output-record-behaviour.test.ts; the shared pinned parser and
// the fixture runner live in tests/unit/helpers/github-output-records.ts.
//
// WHAT THIS LOCKS
//   The three reproduced GITHUB_OUTPUT write points that turn ONE workflow_dispatch
//   `run_id` input into a run-identity output record:
//     .github/workflows/factory-upload.yml     step "Get ID"            -> id
//     .github/workflows/image-processor.yml    step "Get ID"            -> id
//     .github/workflows/factory-aggregate.yml  step "Get Run IDs (...)" -> harvest-id,
//                                                                          process-id
//   GITHUB_OUTPUT is a LINE protocol, so a CR or LF inside a single-line identifier
//   turns one intended record into two. The repaired steps REJECT CR/LF BEFORE the
//   write; they do not strip, trim, concatenate or substitute anything, and they do
//   not degrade to a "latest" lookup.
//
// WHAT THIS DOES *NOT* CLAIM
//   Only "an EXTRA RECORD IS WRITTEN TO THE FILE" was ever reproduced. Final
//   acceptance by the hosted runner, duplicate-key override rules and downstream
//   consumption were NOT verified on a GitHub runner. Nothing here asserts a proven
//   privilege escalation or leak, and nothing here changes work order H Ledger B's
//   0/12 NOT PROVEN status.
import { describe, it, expect } from 'vitest';
import {
  PARSER_VERSION,
  parseOutputFile,
  uploadYml,
  imageYml,
  aggregateYml,
  UPLOAD_STEP,
  IMAGE_STEP,
  AGGREGATE_STEP,
  GATE_MARK
} from './helpers/github-output-records';

describe(`GROUP A — pinned record parser (${PARSER_VERSION})`, () => {
  it('parses the confirmed two-record counterexample file as TWO records', () => {
    expect(parseOutputFile('id=101\nid=202\n')).toEqual([
      { key: 'id', value: '101' },
      { key: 'id', value: '202' }
    ]);
  });
  it('parses a single well-formed record as ONE record and takes no override position', () => {
    expect(parseOutputFile('id=12345\n')).toEqual([{ key: 'id', value: '12345' }]);
  });
  it('recognises the heredoc record form (KEY<<DELIM) as a single record', () => {
    expect(parseOutputFile('k<<E\na\nb\nE\n')).toEqual([{ key: 'k', value: 'a\nb' }]);
  });
  it('throws on an unterminated heredoc rather than silently truncating', () => {
    expect(() => parseOutputFile('k<<E\na\n')).toThrow('HEREDOC_DELIMITER_NOT_FOUND');
  });
  it('skips blank and comment lines without inventing records', () => {
    expect(parseOutputFile('\n# note\nid=7\n')).toEqual([{ key: 'id', value: '7' }]);
  });
});

describe('GROUP A — the three step scripts were extracted, not assumed', () => {
  it('each extracted script still contains its own write point', () => {
    expect(UPLOAD_STEP).toContain('echo "id=$AGGREGATE_RUN_ID" >> "$GITHUB_OUTPUT"');
    expect(IMAGE_STEP).toContain('echo "id=$AGGREGATE_RUN_ID" >> "$GITHUB_OUTPUT"');
    expect(AGGREGATE_STEP).toContain('echo "harvest-id=$HARVEST_RUN_ID" >> "$GITHUB_OUTPUT"');
    expect(AGGREGATE_STEP).toContain('echo "process-id=$PROCESS_RUN_ID" >> "$GITHUB_OUTPUT"');
  });
  it('each extracted script still contains its original empty/null fallback', () => {
    for (const s of [UPLOAD_STEP, IMAGE_STEP]) {
      expect(s).toContain('[ -z "$AGGREGATE_RUN_ID" ] || [ "$AGGREGATE_RUN_ID" == "null" ]');
    }
    expect(AGGREGATE_STEP).toContain('[ -z "$PROCESS_RUN_ID" ] || [ "$PROCESS_RUN_ID" == "null" ]');
  });
});

describe('GROUP A — static record-integrity invariants at the write points', () => {
  const blocks: [string, string][] = [
    ['factory-upload', UPLOAD_STEP],
    ['image-processor', IMAGE_STEP],
    ['factory-aggregate', AGGREGATE_STEP]
  ];

  it('the gate text precedes every output write in each repaired step', () => {
    for (const [label, s] of blocks) {
      const gate = s.indexOf(GATE_MARK);
      const firstWrite = s.indexOf('>> "$GITHUB_OUTPUT"');
      expect(gate, `${label}: gate present`).toBeGreaterThanOrEqual(0);
      expect(firstWrite, `${label}: write present`).toBeGreaterThanOrEqual(0);
      expect(gate, `${label}: gate must execute BEFORE the write`).toBeLessThan(firstWrite);
    }
  });

  it('no repaired step leaves an UNQUOTED $GITHUB_OUTPUT redirect', () => {
    for (const [label, s] of blocks) {
      expect(s.includes('>> $GITHUB_OUTPUT'), `${label}: unquoted redirect`).toBe(false);
    }
  });

  it('output keys and record format are fixed literals, not computed', () => {
    expect(UPLOAD_STEP).toContain('echo "id=');
    expect(IMAGE_STEP).toContain('echo "id=');
    expect(AGGREGATE_STEP).toContain('echo "harvest-id=');
    expect(AGGREGATE_STEP).toContain('echo "process-id=');
  });

  it('the gate constrains CR and LF only — no other character class is introduced', () => {
    for (const [label, s] of blocks) {
      const at = s.indexOf("*$'\\n'*|*$'\\r'*");
      expect(at, `${label}: exact CR/LF-only case pattern`).toBeGreaterThanOrEqual(0);
      expect(s.includes('[:cntrl:]'), `${label}: no control-class widening`).toBe(false);
      expect(s.includes('[:alnum:]'), `${label}: no charset whitelist`).toBe(false);
      expect(s.includes('[0-9]'), `${label}: no numeric-range constraint`).toBe(false);
    }
  });

  it('the gate never repairs a value — no strip, trim, tr or substitution on the id', () => {
    for (const [label, s] of blocks) {
      const gateAt = s.indexOf(GATE_MARK);
      const writeAt = s.indexOf('>> "$GITHUB_OUTPUT"');
      // CODE lines only: the gate's own explanatory comments are not behaviour.
      const code = s
        .slice(gateAt, writeAt)
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
      expect(code.length, `${label}: gate body present`).toBeGreaterThan(0);
      const body = code.join('\n');
      expect(body.includes('tr -d'), `${label}: no strip inside the gate`).toBe(false);
      expect(body.includes('xargs'), `${label}: no trim inside the gate`).toBe(false);
      expect(/\bsed\b/.test(body), `${label}: no rewrite inside the gate`).toBe(false);
      expect(body.includes('latest'), `${label}: no latest fallback inside the gate`).toBe(false);
      // the only '=' allowed is inside the shell test operators, never an assignment
      // to the identifier the step is about to write.
      for (const v of ['AGGREGATE_RUN_ID=', 'PROCESS_RUN_ID=', 'HARVEST_RUN_ID=']) {
        expect(body.includes(v), `${label}: gate reassigns ${v}`).toBe(false);
      }
    }
  });

  it('factory-aggregate validates BOTH ids before EITHER write', () => {
    const loop = AGGREGATE_STEP.indexOf('for RID in "$HARVEST_RUN_ID" "$PROCESS_RUN_ID"; do');
    const firstWrite = AGGREGATE_STEP.indexOf('>> "$GITHUB_OUTPUT"');
    expect(loop).toBeGreaterThanOrEqual(0);
    expect(loop).toBeLessThan(firstWrite);
  });
});

describe('GROUP A-1 — the closed downstream range is covered by the SOURCE gate', () => {
  // The only second-generation GITHUB_OUTPUT record in this chain whose value is
  // INPUT-derived is factory-upload's SEAM_B `expect_run_id`. It is deliberately NOT
  // given a duplicate gate: its value can only come from check-upstream, and its job
  // is `needs: check-upstream`, so a refused Get ID makes that write unreachable.
  it('SEAM_B expect_run_id derives ONLY from the gated check-upstream output', () => {
    const at = uploadYml.indexOf('HANDOFF_PRODUCER_RUN_ID:');
    expect(at).toBeGreaterThanOrEqual(0);
    const line = uploadYml.slice(at, uploadYml.indexOf('\n', at));
    expect(line).toContain('${{ needs.check-upstream.outputs.upstream-run-id }}');
    const occurrences = uploadYml.split('HANDOFF_PRODUCER_RUN_ID:').length - 1;
    expect(occurrences, 'a second producer of this env would break the proof').toBe(1);
    expect(uploadYml).toContain('PID="${HANDOFF_PRODUCER_RUN_ID}"');
    expect(uploadYml).toContain('echo "expect_run_id=${PID}" >> "$GITHUB_OUTPUT"');
  });

  it('the SEAM_B job is gated behind check-upstream, so a refusal skips it', () => {
    const at = uploadYml.indexOf('echo "expect_run_id=${PID}" >> "$GITHUB_OUTPUT"');
    expect(at).toBeGreaterThan(0);
    const jobStart = uploadYml.lastIndexOf('\n  ', uploadYml.lastIndexOf('\n    name:', at));
    const jobText = uploadYml.slice(jobStart, at);
    expect(jobText).toContain('needs:');
    expect(jobText).toContain('check-upstream');
  });

  it('check-upstream outputs are sourced ONLY from the gated get-id step', () => {
    expect(uploadYml).toContain('upstream-run-id: ${{ steps.get-id.outputs.id }}');
    expect(imageYml).toContain('upstream-run-id: ${{ steps.get-id.outputs.id }}');
    expect(aggregateYml).toContain('harvest-id: ${{ steps.get-ids.outputs.harvest-id }}');
    expect(aggregateYml).toContain('process-id: ${{ steps.get-ids.outputs.process-id }}');
  });

  it('the three workflows write no GITHUB_ENV record at all (nothing else to gate)', () => {
    const all: [string, string][] = [
      ['upload', uploadYml],
      ['image', imageYml],
      ['aggregate', aggregateYml]
    ];
    for (const [label, y] of all) {
      expect(y.includes('GITHUB_ENV'), `${label}: unexpected GITHUB_ENV writer`).toBe(false);
    }
  });
});
