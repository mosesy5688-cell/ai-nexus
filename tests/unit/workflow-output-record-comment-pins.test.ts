// tests/unit/workflow-output-record-comment-pins.test.ts
//
// WORK ORDER L -- GROUP A (static): source text pins for the three RECORD-INTEGRITY
// GATE comments (G1 ruling L-G1-01, PM item 3). Split out of
// workflow-output-record-behaviour.test.ts to keep every file under the CES limit.
// Comment TEXT only; nothing here says anything about runtime behaviour.
import { describe, it, expect } from 'vitest';
import {
  UPLOAD_STEP,
  IMAGE_STEP,
  AGGREGATE_STEP,
  uploadYml,
  imageYml,
  aggregateYml
} from './helpers/github-output-records';

// L-G1-01 item 3: the gate comments must not return to "a CR or LF turns one record
// into two". These pin comment TEXT only; they say nothing about runtime behaviour.
describe('GROUP A -- source text pins for the corrected gate-comment wording', () => {
  const NEW_WORDING = [
    '# the reproduced multi-record counterexample: the file gains an extra record.',
    '# A CR is refused CONSERVATIVELY with it; this gate does NOT claim that a lone',
    '# CR ends a record on every runner platform.'
  ].join('\n');
  // The claim's CORE phrase is banned, not one wording of it, in the step AND anywhere
  // in the workflow file.
  const BANNED = ['turns one intended record into two', 'so a CR or LF inside'];
  const steps: [string, string, string][] = [
    ['factory-upload', UPLOAD_STEP, uploadYml],
    ['image-processor', IMAGE_STEP, imageYml],
    ['factory-aggregate', AGGREGATE_STEP, aggregateYml]
  ];
  for (const [label, s, yml] of steps) {
    it(`source text pins: ${label} gate comment has the bounded CR wording, not the old claim`, () => {
      expect(s).toContain(NEW_WORDING);
      for (const b of BANNED) {
        expect(s.includes(b), `${label} step: banned claim "${b}"`).toBe(false);
        expect(yml.includes(b), `${label} file: banned claim "${b}"`).toBe(false);
      }
    });
  }
});
