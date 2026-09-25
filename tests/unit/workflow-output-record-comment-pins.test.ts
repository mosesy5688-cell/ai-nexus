// tests/unit/workflow-output-record-comment-pins.test.ts
//
// WORK ORDER L -- GROUP A (static): EQUALITY pins on the three gate steps
// (factory-upload "Get ID", image-processor "Get ID", factory-aggregate "Get Run IDs";
// G1 ruling L-G1-01 item 3; work order L A-2 / A-3). Pinned against the baseline:
//   1. the FULL run text as extracted by extractRun() (the source the behaviour tests
//      execute), line for line, COMMENT LINES INCLUDED -- fallback, gate comment, case
//      arms, output writes (fixed keys, format and target, no extra write);
//   2. the step's non-run keys, read from the YAML: the ordered step-level key list
//      (an added shell:, if:, continue-on-error:, timeout-minutes: ... is red), the
//      exact name:, id:, if: and shell: (or their absence), and every env: line,
//      key AND value expression, verbatim;
//   3. the enclosing job's `outputs:` mapping lines that read the step, verbatim, and
//      that the step sits inside that job;
//   4. two historical over-strong phrases, banned anywhere in each workflow file;
//   5. (hub v101 m1) in each workflow file, re-read from disk: ZERO `defaults:` keys
//      at any indentation (workflow and job level; would replace the gate step's
//      default shell) and ZERO YAML explicit-key lines (`? key`), which could hide
//      either pin; and NO job-level `continue-on-error` key (quotes stripped,
//      trimmed) on each gate job.
// LIMIT: everything else -- triggers, permissions, job-level `container:` and
// `runs-on` (both can change the gate step's default shell), other jobs, new steps
// in the same job (J4) -- is left to G1 structural diff review. Not runtime
// evidence (see workflow-output-record-behaviour.test.ts).
import { describe, it, expect } from 'vitest';
import {
  UPLOAD_STEP,
  IMAGE_STEP,
  AGGREGATE_STEP,
  uploadYml,
  imageYml,
  aggregateYml,
  read,
  UPLOAD_WF,
  IMAGE_WF,
  AGGREGATE_WF
} from './helpers/github-output-records';

// Baseline run text, one array element per line (JSON-escaped string literals).
const UPLOAD_RUN = [
  "AGGREGATE_RUN_ID=\"$INPUT_AGGREGATE_RUN_ID\"",
  "if [ -z \"$AGGREGATE_RUN_ID\" ] || [ \"$AGGREGATE_RUN_ID\" == \"null\" ]; then",
  "  echo \"Finding latest successful Aggregate run on main...\"",
  "  AGGREGATE_RUN_ID=$(gh run list --workflow factory-aggregate.yml --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId' | tr -d '[:space:]')",
  "fi",
  "# RECORD-INTEGRITY GATE (work order L / A-2). A run id is a SINGLE-LINE",
  "# identifier and GITHUB_OUTPUT is a LINE protocol. An LF inside the value is",
  "# the reproduced multi-record counterexample: the file gains an extra record.",
  "# A CR is refused CONSERVATIVELY with it; this gate does NOT claim that a lone",
  "# CR ends a record on every runner platform. Reject BEFORE the write.",
  "# This is NOT a sanitizer: nothing is stripped, trimmed or concatenated, no",
  "# substitute identity is invented, and the empty/null fallback above is",
  "# unchanged and still runs first (a rejection never degrades to \"latest\").",
  "case \"$AGGREGATE_RUN_ID\" in",
  "  *$'\\n'*|*$'\\r'*)",
  "    echo \"::error::Get ID: resolved Aggregate run id contains CR/LF - refusing to write a multi-record GITHUB_OUTPUT. Fail-closed.\"",
  "    exit 1",
  "    ;;",
  "esac",
  "echo \"id=$AGGREGATE_RUN_ID\" >> \"$GITHUB_OUTPUT\""
];
const IMAGE_RUN = [
  "# 1. Start with the Aggregate Run ID (Triggering event or manual input)",
  "AGGREGATE_RUN_ID=\"$INPUT_AGGREGATE_RUN_ID\"",
  "",
  "# 2. If missing, find the latest successful Aggregate run on MAIN",
  "if [ -z \"$AGGREGATE_RUN_ID\" ] || [ \"$AGGREGATE_RUN_ID\" == \"null\" ]; then",
  "  echo \"\ud83d\udd0d Manual dispatch: Finding latest successful Aggregate run on main branch...\"",
  "  AGGREGATE_RUN_ID=$(gh run list --workflow factory-aggregate.yml --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId' | tr -d '[:space:]')",
  "fi",
  "",
  "# RECORD-INTEGRITY GATE (work order L / A-2). A run id is a SINGLE-LINE",
  "# identifier and GITHUB_OUTPUT is a LINE protocol. An LF inside the value is",
  "# the reproduced multi-record counterexample: the file gains an extra record.",
  "# A CR is refused CONSERVATIVELY with it; this gate does NOT claim that a lone",
  "# CR ends a record on every runner platform. Reject BEFORE the write.",
  "# This is NOT a sanitizer: nothing is stripped, trimmed or concatenated, no",
  "# substitute identity is invented, and the empty/null fallback above is",
  "# unchanged and still runs first (a rejection never degrades to \"latest\").",
  "case \"$AGGREGATE_RUN_ID\" in",
  "  *$'\\n'*|*$'\\r'*)",
  "    echo \"::error::Get ID: resolved Aggregate run id contains CR/LF - refusing to write a multi-record GITHUB_OUTPUT. Fail-closed.\"",
  "    exit 1",
  "    ;;",
  "esac",
  "echo \"id=$AGGREGATE_RUN_ID\" >> \"$GITHUB_OUTPUT\"",
  "echo \"\u2705 Resolved Aggregate ID (Main): $AGGREGATE_RUN_ID\""
];
const AGGREGATE_RUN = [
  "# 1. Start with the Process Run ID (Triggering event or manual input)",
  "PROCESS_RUN_ID=\"$INPUT_PROCESS_RUN_ID\"",
  "",
  "# 2. If PROCESS_RUN_ID is missing, find the latest successful Process run on MAIN",
  "if [ -z \"$PROCESS_RUN_ID\" ] || [ \"$PROCESS_RUN_ID\" == \"null\" ]; then",
  "  echo \"\ud83d\udd0d Manual dispatch: Finding latest successful Process run on main branch...\"",
  "  PROCESS_RUN_ID=$(gh run list --workflow factory-process.yml --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId' | tr -d '[:space:]')",
  "fi",
  "",
  "# 3. Find the latest successful Harvest run on MAIN (The Production Source of Truth)",
  "HARVEST_RUN_ID=$(gh run list --workflow factory-harvest.yml --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId' | tr -d '[:space:]')",
  "",
  "# RECORD-INTEGRITY GATE (work order L / A-2). Both ids are SINGLE-LINE",
  "# identifiers and GITHUB_OUTPUT is a LINE protocol. An LF inside a value is",
  "# the reproduced multi-record counterexample: the file gains an extra record.",
  "# A CR is refused CONSERVATIVELY with it; this gate does NOT claim that a lone",
  "# CR ends a record on every runner platform. BOTH ids are validated BEFORE",
  "# EITHER write, so a rejection can never leave one usable record behind.",
  "# This is NOT a sanitizer: nothing is stripped, trimmed or concatenated, no",
  "# substitute identity is invented, and the empty/null fallback above is",
  "# unchanged and still runs first (a rejection never degrades to \"latest\").",
  "for RID in \"$HARVEST_RUN_ID\" \"$PROCESS_RUN_ID\"; do",
  "  case \"$RID\" in",
  "    *$'\\n'*|*$'\\r'*)",
  "      echo \"::error::Get Run IDs: a resolved run id contains CR/LF - refusing to write a multi-record GITHUB_OUTPUT. Fail-closed.\"",
  "      exit 1",
  "      ;;",
  "  esac",
  "done",
  "echo \"harvest-id=$HARVEST_RUN_ID\" >> \"$GITHUB_OUTPUT\"",
  "echo \"process-id=$PROCESS_RUN_ID\" >> \"$GITHUB_OUTPUT\"",
  "echo \"\u2705 Resolved Harvest ID (Main): $HARVEST_RUN_ID\"",
  "echo \"\u2705 Resolved Process ID (Main): $PROCESS_RUN_ID\""
];

type GateStep = { keys: string[]; name: string; id: string | null; if: string | null; shell: string | null; env: string[] };
const indentOf = (raw: string) => raw.length - raw.trimStart().length;

// Indentation-anchored reader (no YAML library: transitive-only, repo convention).
// Throws on any shape it does not understand, so the pin cannot silently shrink.
function readGateStep(yml: string, name: string): GateStep {
  const head = `      - name: ${name}\n`;
  const at = yml.indexOf(head);
  if (at < 0 || yml.indexOf(head, at + 1) >= 0) throw new Error(`gate step not unique: ${name}`);
  const s: GateStep = { keys: ['name'], name, id: null, if: null, shell: null, env: [] };
  let cur = 'name';
  for (const raw of yml.slice(at).split('\n').slice(1)) {
    if (raw.trim() === '') continue;
    const ind = indentOf(raw);
    if (ind <= 6) break; // next step or next job
    if (ind === 8) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(raw.trim());
      if (!m) throw new Error(`unexpected step line: ${raw}`);
      cur = m[1];
      s.keys.push(cur);
      if (cur === 'id') s.id = m[2];
      if (cur === 'if') s.if = m[2];
      if (cur === 'shell') s.shell = m[2];
      if (cur === 'env' && m[2] !== '') s.env.push(`<inline:${m[2]}>`);
    } else if (cur === 'env') {
      if (ind !== 10) throw new Error(`unexpected env line: ${raw}`);
      s.env.push(raw.trim());
    } else if (cur !== 'run') {
      throw new Error(`unexpected nested line under ${cur}: ${raw}`);
    }
  }
  return s;
}

// The job block's `outputs:` lines (verbatim, trimmed) and whether the step is inside it.
function readJob(yml: string, job: string, stepName: string) {
  const lines = yml.split('\n');
  const j = lines.indexOf(`  ${job}:`);
  if (j < 0 || lines.indexOf(`  ${job}:`, j + 1) >= 0) throw new Error(`job not unique: ${job}`);
  const outputs: string[] = [];
  const jobKeys: string[] = [];
  let inOut = false;
  let hasStep = false;
  for (const raw of lines.slice(j + 1)) {
    if (raw.trim() === '') continue;
    const ind = indentOf(raw);
    if (ind <= 2) break;
    if (raw === `      - name: ${stepName}`) hasStep = true;
    if (ind === 4) {
      inOut = raw.trim() === 'outputs:';
      jobKeys.push(raw.trim().split(':')[0].replace(/["']/g, '').trim());
    } else if (inOut) outputs.push(raw.trim());
  }
  return { outputs, hasStep, jobKeys };
}

// Baseline structure, GENERATED from the committed YAML by a Python mirror of the
// readers above (scratchpad/wo-l-r2-gen-struct.py), then pasted -- not typed.
const UPLOAD_STRUCT: GateStep = {"keys": ["name", "id", "env", "run"], "name": "Get ID", "id": "get-id", "if": null, "shell": null, "env": ["INPUT_AGGREGATE_RUN_ID: ${{ inputs.run_id || github.event.workflow_run.id }}"]};
const IMAGE_STRUCT: GateStep = {"keys": ["name", "id", "env", "run"], "name": "Get ID", "id": "get-id", "if": null, "shell": null, "env": ["GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}", "INPUT_AGGREGATE_RUN_ID: ${{ inputs.run_id || github.event.workflow_run.id }}"]};
const AGGREGATE_STRUCT: GateStep = {"keys": ["name", "id", "env", "run"], "name": "Get Run IDs (Harvest & Process)", "id": "get-ids", "if": null, "shell": null, "env": ["GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}", "INPUT_PROCESS_RUN_ID: ${{ inputs.run_id || github.event.workflow_run.id }}"]};
const UPLOAD_OUTPUTS = ["upstream-run-id: ${{ steps.get-id.outputs.id }}"];
const IMAGE_OUTPUTS = ["upstream-run-id: ${{ steps.get-id.outputs.id }}"];
const AGGREGATE_OUTPUTS = ["harvest-id: ${{ steps.get-ids.outputs.harvest-id }}", "process-id: ${{ steps.get-ids.outputs.process-id }}"];

const STEPS: [string, string, string, string[], string, GateStep, string[]][] = [
  ['factory-upload Get ID', UPLOAD_STEP, uploadYml, UPLOAD_RUN, 'Get ID', UPLOAD_STRUCT, UPLOAD_OUTPUTS],
  ['image-processor Get ID', IMAGE_STEP, imageYml, IMAGE_RUN, 'Get ID', IMAGE_STRUCT, IMAGE_OUTPUTS],
  [
    'factory-aggregate Get Run IDs',
    AGGREGATE_STEP,
    aggregateYml,
    AGGREGATE_RUN,
    'Get Run IDs (Harvest & Process)',
    AGGREGATE_STRUCT,
    AGGREGATE_OUTPUTS
  ]
];

describe('GROUP A -- the three gate steps pinned by EQUALITY', () => {
  for (const [label, step, yml, baseline, stepName, struct, outputs] of STEPS) {
    it(`${label}: the FULL run text equals the baseline, line for line (comments included)`, () => {
      expect(step.split('\n')).toEqual([...baseline, '']);
    });
    // `shell:` is pinned ABSENT (shell: null, and no 'shell' in keys): absent => the
    // runner default is bash; this suite does not simulate sh.
    it(`${label}: step keys (ordered), name, id, if, shell and every env: line equal the baseline`, () => {
      expect(readGateStep(yml, stepName)).toEqual(struct);
    });
    it(`${label}: the job outputs: mapping lines equal the baseline and the step is inside that job`, () => {
      const job = readJob(yml, 'check-upstream', stepName);
      expect(job.outputs).toEqual(outputs);
      expect(job.hasStep).toBe(true);
    });
    it(`${label}: the gate job has NO job-level continue-on-error`, () => {
      const job = readJob(yml, 'check-upstream', stepName);
      expect(job.jobKeys.length, 'job keys were read').toBeGreaterThan(0);
      expect(job.jobKeys).not.toContain('continue-on-error');
    });
    it(`${label}: the historical over-strong phrases appear nowhere in the workflow file`, () => {
      for (const b of ['turns one intended record into two', 'so a CR or LF inside']) {
        expect(yml.includes(b), `${label}: banned phrase "${b}"`).toBe(false);
      }
    });
  }
});

// hub v101 m1: a `defaults:` key at ANY indentation (workflow or job level), quoted or
// not. Each file is re-read from disk; an unreadable or empty file is red.
const DEFAULTS_KEY = /^[ \t]*["']?defaults["']?[ \t]*:/gm;
const EXPLICIT_KEY = /^[ \t]*\?([ \t]|$)/gm; // YAML explicit-key line: `? key` or a bare `?`
describe('GROUP A -- no `defaults:` key anywhere in the three workflows', () => {
  it('the defaults-key and explicit-key matchers are not vacuous', () => {
    const probe = 'defaults:\n  run:\njobs:\n  a:\n    defaults:\n    "defaults" :\n    x: defaults: no\n';
    expect(probe.match(DEFAULTS_KEY)?.length).toBe(3);
    expect('? defaults\n: x\n  a:\n    ? continue-on-error\n    : true\n    ?\n    x: a?b\n'.match(EXPLICIT_KEY)?.length).toBe(3);
  });
  for (const wf of [UPLOAD_WF, IMAGE_WF, AGGREGATE_WF]) {
    it(`${wf}: count of \`defaults:\` keys == 0 and count of explicit-key (\`? \`) lines == 0`, () => {
      const text = read(wf);
      expect(text.length, `${wf} must be readable and non-empty`).toBeGreaterThan(0);
      expect(text.match(DEFAULTS_KEY) ?? []).toEqual([]);
      expect(text.match(EXPLICIT_KEY) ?? []).toEqual([]);
    });
  }
});
