// tests/unit/workflow-output-record-comment-pins.test.ts
//
// WORK ORDER L -- GROUP A (static): EQUALITY pins on the source text of the three
// RECORD-INTEGRITY GATES (G1 ruling L-G1-01 item 3; work order L A-2 / A-3).
// For each of the three steps this pins, by equality against the baseline text:
//   * the line immediately BEFORE the gate (so no line can be slipped in above it);
//   * the gate's COMMENT BLOCK, every line, in order (so no claim can be reworded,
//     paraphrased or added inside it);
//   * the gate's CODE up to the first output write -- the case statement with
//     exactly its baseline arms (so no extra accept or reject arm, i.e. no other
//     character class, can be added: A-3).
// Additionally the two historical over-strong phrases are banned anywhere in each
// workflow FILE. These are source-text pins; runtime behaviour is covered in
// workflow-output-record-behaviour.test.ts.
import { describe, it, expect } from 'vitest';
import {
  UPLOAD_STEP,
  IMAGE_STEP,
  AGGREGATE_STEP,
  uploadYml,
  imageYml,
  aggregateYml,
  GATE_MARK
} from './helpers/github-output-records';

const COMMENT_TAIL = [
  '# This is NOT a sanitizer: nothing is stripped, trimmed or concatenated, no',
  '# substitute identity is invented, and the empty/null fallback above is',
  '# unchanged and still runs first (a rejection never degrades to "latest").'
];
const SINGLE_COMMENT = [
  '# RECORD-INTEGRITY GATE (work order L / A-2). A run id is a SINGLE-LINE',
  '# identifier and GITHUB_OUTPUT is a LINE protocol. An LF inside the value is',
  '# the reproduced multi-record counterexample: the file gains an extra record.',
  '# A CR is refused CONSERVATIVELY with it; this gate does NOT claim that a lone',
  '# CR ends a record on every runner platform. Reject BEFORE the write.',
  ...COMMENT_TAIL
];
const AGGREGATE_COMMENT = [
  '# RECORD-INTEGRITY GATE (work order L / A-2). Both ids are SINGLE-LINE',
  '# identifiers and GITHUB_OUTPUT is a LINE protocol. An LF inside a value is',
  '# the reproduced multi-record counterexample: the file gains an extra record.',
  '# A CR is refused CONSERVATIVELY with it; this gate does NOT claim that a lone',
  '# CR ends a record on every runner platform. BOTH ids are validated BEFORE',
  '# EITHER write, so a rejection can never leave one usable record behind.',
  ...COMMENT_TAIL
];
const MSG = 'refusing to write a multi-record GITHUB_OUTPUT. Fail-closed."';
const SINGLE_CODE = [
  'case "$AGGREGATE_RUN_ID" in',
  "  *$'\\n'*|*$'\\r'*)",
  `    echo "::error::Get ID: resolved Aggregate run id contains CR/LF - ${MSG}`,
  '    exit 1',
  '    ;;',
  'esac'
];
const AGGREGATE_CODE = [
  'for RID in "$HARVEST_RUN_ID" "$PROCESS_RUN_ID"; do',
  '  case "$RID" in',
  "    *$'\\n'*|*$'\\r'*)",
  `      echo "::error::Get Run IDs: a resolved run id contains CR/LF - ${MSG}`,
  '      exit 1',
  '      ;;',
  '  esac',
  'done'
];

// Split the extracted step at its single gate: the line before it, the comment
// block (leading '#' lines), and the code up to the first GITHUB_OUTPUT write.
function gateRegion(s: string) {
  const lines = s.split('\n');
  const g = lines.findIndex((l) => l.startsWith(GATE_MARK));
  const c = lines.findIndex((l, i) => i > g && !l.startsWith('#'));
  const w = lines.findIndex((l, i) => i > g && l.includes('>> "$GITHUB_OUTPUT"'));
  if (g < 1 || c < 0 || w < c) throw new Error('gate region not found');
  return { marks: s.split(GATE_MARK).length - 1, before: lines[g - 1], comment: lines.slice(g, c), code: lines.slice(c, w) };
}

const STEPS: [string, string, string, string, string[], string[]][] = [
  ['factory-upload', UPLOAD_STEP, uploadYml, 'fi', SINGLE_COMMENT, SINGLE_CODE],
  ['image-processor', IMAGE_STEP, imageYml, '', SINGLE_COMMENT, SINGLE_CODE],
  ['factory-aggregate', AGGREGATE_STEP, aggregateYml, '', AGGREGATE_COMMENT, AGGREGATE_CODE]
];

describe('GROUP A -- gate source text pinned by EQUALITY', () => {
  for (const [label, step, yml, before, comment, code] of STEPS) {
    it(`${label}: exactly one gate, and the line before it is the baseline line`, () => {
      const r = gateRegion(step);
      expect(r.marks).toBe(1);
      expect(r.before).toBe(before);
    });
    it(`${label}: the gate comment block equals the corrected baseline, line for line`, () => {
      expect(gateRegion(step).comment).toEqual(comment);
    });
    it(`${label}: the gate code (case statement, exactly its baseline arms) equals the baseline`, () => {
      expect(gateRegion(step).code).toEqual(code);
    });
    it(`${label}: the historical over-strong phrases appear nowhere in the workflow file`, () => {
      for (const b of ['turns one intended record into two', 'so a CR or LF inside']) {
        expect(yml.includes(b), `${label}: banned phrase "${b}"`).toBe(false);
      }
    });
  }
});
