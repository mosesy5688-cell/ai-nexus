// tests/unit/workflow-output-record-comment-pins.test.ts
//
// WORK ORDER L -- GROUP A (static): EQUALITY pins on the source text of the three
// gate steps (G1 ruling L-G1-01 item 3; work order L A-2 / A-3).
// For each of factory-upload "Get ID", image-processor "Get ID" and
// factory-aggregate "Get Run IDs", the FULL run text -- as extracted by extractRun()
// in helpers/github-output-records.ts, the same source the behaviour tests execute --
// must equal the baseline below line for line, COMMENT LINES INCLUDED. That pins in
// one place: the fallback, the gate comment block, the gate case statement with
// exactly its baseline arms, and the output writes (fixed keys, fixed format, fixed
// target, no extra write). Separately, two historical over-strong phrases are banned
// anywhere in each workflow FILE. Nothing here pins workflow YAML outside these three
// run blocks, and nothing here is runtime evidence
// (see workflow-output-record-behaviour.test.ts).
import { describe, it, expect } from 'vitest';
import {
  UPLOAD_STEP,
  IMAGE_STEP,
  AGGREGATE_STEP,
  uploadYml,
  imageYml,
  aggregateYml
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

const STEPS: [string, string, string, string[]][] = [
  ['factory-upload Get ID', UPLOAD_STEP, uploadYml, UPLOAD_RUN],
  ['image-processor Get ID', IMAGE_STEP, imageYml, IMAGE_RUN],
  ['factory-aggregate Get Run IDs', AGGREGATE_STEP, aggregateYml, AGGREGATE_RUN]
];

describe('GROUP A -- full gate-step run text pinned by EQUALITY', () => {
  for (const [label, step, yml, baseline] of STEPS) {
    it(`${label}: the FULL run text equals the baseline, line for line (comments included)`, () => {
      expect(step.split('\n')).toEqual([...baseline, '']);
    });
    it(`${label}: the historical over-strong phrases appear nowhere in the workflow file`, () => {
      for (const b of ['turns one intended record into two', 'so a CR or LF inside']) {
        expect(yml.includes(b), `${label}: banned phrase "${b}"`).toBe(false);
      }
    });
  }
});
