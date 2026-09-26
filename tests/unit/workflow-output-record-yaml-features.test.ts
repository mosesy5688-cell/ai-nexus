// tests/unit/workflow-output-record-yaml-features.test.ts
//
// WORK ORDER L -- GROUP A (static): a FEATURE BAN on non-plain YAML key spellings in
// the three gate workflows (factory-upload, image-processor, factory-aggregate).
//
// WHY: workflow-output-record-comment-pins.test.ts pins ZERO `defaults:` keys and NO
// job-level `continue-on-error` on each gate job, but only for plain, quoted and
// explicit-key (`? key`) spellings. A YAML parser also accepts the same keys spelled
// with a tag (`!!str defaults:`), an escape inside a double-quoted key
// (`"defaul\x74s":`), an anchor / alias / merge key (`<<: *coe`), inside a flow
// mapping (`{ defaults: ... }`), or on a "line" that a non-LF line break starts (a
// lone CR hides `continue-on-error: true` from every line-based pin). Whether GitHub's
// own parser accepts each of these is NOT proven here; the ban is conservative. Per
// hub v101 sec. 3 r1, G1 structural diff review only sees the PR under review and
// cannot guard FUTURE PRs, so this class is pinned rather than delegated.
//
// WHAT THIS PINS: each workflow file, re-read from disk, is non-empty and has ZERO
//   * lines matching each FEATURES pattern: single-line flow mappings naming a pinned
//     key, letter-leading anchors / aliases (value or key position), key-position
//     tags, escaped double-quoted keys, merge keys;
//   * non-LF line breaks (NON_LF_BREAKS): lone CR, NEL, LINE SEPARATOR, PARAGRAPH
//     SEPARATOR, checked on the text as read() returns it (read() rewrites CRLF to LF
//     and nothing else, so a lone CR survives to be seen).
// Every pattern and every character has a non-vacuity probe.
// WHAT THIS DOES NOT PIN: multi-line flow mappings and escapes inside flow mappings;
// those remain for G1 structural diff review. Not runtime evidence.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { read, REPO, UPLOAD_WF, IMAGE_WF, AGGREGATE_WF } from './helpers/github-output-records';

// YAML 1.2 treats CR (alone or before LF) as a line break; YAML 1.1 additionally
// treats NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR as line breaks. Which of these
// GitHub's own workflow parser honours is NOT proven; all four are banned.
const NON_LF_BREAKS: [string, string][] = [
  ['lone CR', '\r'],
  ['NEL (U+0085)', '\u0085'],
  ['LINE SEPARATOR (U+2028)', '\u2028'],
  ['PARAGRAPH SEPARATOR (U+2029)', '\u2029']
];
const breaksIn = (text: string) => NON_LF_BREAKS.filter(([, c]) => text.includes(c)).map(([n]) => n);

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
    it(`${wf}: as read() returns it, contains no non-LF line break (CR, NEL, LS, PS)`, () => {
      const text = read(wf);
      expect(text.length, `${wf} must be readable and non-empty`).toBeGreaterThan(0);
      expect(breaksIn(text), `${wf}: non-LF line breaks`).toEqual([]);
    });
  }
});

describe('GROUP A -- non-LF line-break ban: the check is not vacuous', () => {
  // Real files through the real read(): a CRLF file must pass (read() folds CRLF to LF);
  // a file carrying each banned character must be flagged for exactly that character.
  const probe = (content: string) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wo-l-yf-')), 'probe.yml');
    fs.writeFileSync(f, content, 'utf8');
    const rel = path.relative(REPO, f);
    expect(path.isAbsolute(rel), 'probe must be reachable relative to REPO').toBe(false);
    return breaksIn(read(rel));
  };
  it('a plain CRLF file passes after read()', () => {
    expect(probe('jobs:\r\n  a:\r\n    runs-on: ubuntu-latest\r\n')).toEqual([]);
  });
  for (const [name, c] of NON_LF_BREAKS) {
    it(`a file with ${name} used as a break is flagged`, () => {
      expect(probe(`jobs:\r\n  a:\r\n    runs-on: ubuntu-latest${c}    continue-on-error: true\r\n`)).toEqual([name]);
    });
  }
});
