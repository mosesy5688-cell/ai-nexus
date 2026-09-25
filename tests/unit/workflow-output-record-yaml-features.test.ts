// tests/unit/workflow-output-record-yaml-features.test.ts
//
// WORK ORDER L -- GROUP A (static): a FEATURE BAN on non-plain YAML key spellings in
// the three gate workflows (factory-upload, image-processor, factory-aggregate).
//
// WHY: workflow-output-record-comment-pins.test.ts pins ZERO `defaults:` keys and NO
// job-level `continue-on-error` on each gate job, but only for plain, quoted and
// explicit-key (`? key`) spellings. A YAML parser also accepts the same keys spelled
// with a tag (`!!str defaults:`), an escape inside a double-quoted key
// (`"defaul\x74s":`), an anchor / alias / merge key (`<<: *coe`), or inside a flow
// mapping (`{ defaults: ... }`). Whether GitHub's own parser accepts each of these is
// NOT proven here; the ban is conservative. Per hub v101 sec. 3 r1, G1 structural diff
// review only sees the PR under review and cannot guard FUTURE PRs, so this class is
// pinned rather than delegated.
//
// WHAT THIS PINS: each workflow file, re-read from disk, is non-empty and has ZERO
// lines matching each pattern in FEATURES below. Every pattern has a non-vacuity probe:
// a sample that must match and near-misses that must not.
// WHAT THIS DOES NOT PIN: a flow mapping spread over several lines, or an escape
// inside a flow mapping; those remain for G1 structural diff review. Not runtime
// evidence.
import { describe, it, expect } from 'vitest';
import { read, UPLOAD_WF, IMAGE_WF, AGGREGATE_WF } from './helpers/github-output-records';

type Feature = { name: string; re: RegExp; hit: string[]; miss: string[] };
const FEATURES: Feature[] = [
  {
    name: 'key-position tag',
    re: /^[ \t]*(-[ \t]+)?!/m,
    hit: ['    !!str continue-on-error: true', '!!str defaults:', '  - !!str x: y'],
    miss: ['    run: echo "!"', '    if: ${{ !cancelled() }}']
  },
  {
    name: 'merge key',
    re: /^[ \t]*(-[ \t]+)?<<[ \t]*:/m,
    hit: ['    <<: *coe', '  - << : *base'],
    miss: ['    run: cat <<EOF', '          x=1 <<: no']
  },
  {
    name: 'anchor / alias value',
    re: /:[ \t]*[&*][A-Za-z]/m,
    hit: ['  base: &coe', '    x: *coe'],
    miss: ["    key: '&x'", '    run: echo a&b', '    glob: "*.yml"']
  },
  {
    // added beyond the brief's list: an anchor or alias in KEY position
    name: 'anchor / alias key',
    re: /^[ \t]*(-[ \t]+)?[&*][A-Za-z]/m,
    hit: ['    &coe continue-on-error: true', '    *coe : true'],
    miss: ['    - "*.yml"', '    * not-a-key']
  },
  {
    name: 'escaped double-quoted key',
    re: /^[ \t]*(-[ \t]+)?"[^"]*\\[^"]*"[ \t]*:/m,
    hit: ['    "continue\\x2don-error": true', '"defaul\\x74s":', '  - "a\\u0062": 1'],
    miss: ['    "plain-key": x', '    run: echo "a\\nb"']
  },
  {
    name: 'flow mapping naming a pinned key',
    re: /\{[^}\n]*\b(defaults|continue-on-error)\b/m,
    hit: ['    env: { defaults: x }', '  job: {continue-on-error: true}'],
    miss: ['    with: { node-version: 22 }', '    x: ${{ inputs.continue_on_error }}']
  }
];

describe('GROUP A -- YAML feature ban: the matchers are not vacuous', () => {
  for (const f of FEATURES) {
    it(`${f.name}: every sample matches and every near-miss does not`, () => {
      for (const h of f.hit) expect(f.re.test(h), `must match: ${JSON.stringify(h)}`).toBe(true);
      for (const m of f.miss) expect(f.re.test(m), `must NOT match: ${JSON.stringify(m)}`).toBe(false);
    });
  }
});

describe('GROUP A -- YAML feature ban: zero hits in the three gate workflows', () => {
  for (const wf of [UPLOAD_WF, IMAGE_WF, AGGREGATE_WF]) {
    it(`${wf}: re-read from disk, non-empty, and no line uses a banned YAML key feature`, () => {
      const text = read(wf);
      expect(text.length, `${wf} must be readable and non-empty`).toBeGreaterThan(0);
      const lines = text.split('\n');
      for (const f of FEATURES) {
        const hits = lines.filter((l) => f.re.test(l));
        expect(hits, `${wf}: ${f.name}`).toEqual([]);
      }
    });
  }
});
