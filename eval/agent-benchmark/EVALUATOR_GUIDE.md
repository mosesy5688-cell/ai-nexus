# Evaluator Guide — A1 Neutral-Agent Benchmark (D-189)

This guide documents (a) the **material-independence basis** of the runtime matrix so the
benchmark-method reviewer can adjudicate it, and (b) the **human-adjudication plan** that
gates qualification and the final evaluation. Implementation is authorized; **execution is
not** until this plan is executable and a separate Founder ruling is issued.

## 1. Material independence of the three runtimes (Option A)

D-189 §C requires independence to be established by **materially-distinct Agent host/loop
implementations**, not by a cosmetic change. The matrix uses **Option A**:

| cell | agent loop (host file) | loop mechanics | model family | transport |
|------|------------------------|----------------|--------------|-----------|
| CELL-1 | `src/host_ollama_direct.ts` | single-shot: one tool round, then forced finalization | Qwen2.5 | REST |
| CELL-2 | `src/host_mcp_client.ts` | streamable-http MCP agent loop: `tools/list` + multi-turn `tools/call` | Llama-3.1 | MCP |
| CELL-3 | `src/host_react_loop.ts` | ReAct text protocol: Thought/Action/Observation, parsed dispatch, many turns | Mistral | SDK |

Independence holds on **three axes at once**: the control loop (single-shot vs MCP
multi-turn vs ReAct text-protocol), the model family (Qwen2.5 / Llama-3.1 / Mistral), and
the transport (REST / MCP / SDK).

**Why this is required.** Changing *only the model* while keeping one loop, OR changing
*only REST→MCP* while keeping one model, would NOT by itself prove independence: a single
loop implementation can encode a single idiosyncratic tool-selection bias that rides across
models or transports. Three distinct loops break that shared-implementation confound. The
reviewer should confirm the three loops are genuinely different code paths (they are
separate files with distinct turn structures and distinct tool-dispatch parsing), not three
parameterizations of one loop.

`host_react_loop.ts` is the one additional local Agent-host adapter authorized by D-189 §C
for the third-runtime independence; it is named clearly and noted here and in the PR.

Optional hosted provider cells (Claude-class / GPT-class) are `BLOCKED_PENDING_CREDENTIAL`,
off by default, and are never counted as passing while blocked.

## 2. Generation + session isolation (D-189 §D)

Per-cell generation parameters (temperature, top_p, top_k, repetition penalty, seed policy,
context window, max output tokens, tool-choice mode, max agent turns, max tool calls, stop
conditions, model server version, model digest, prompt serialization format) are pinned in
`config/matrix.json`. Every episode uses a **fresh agent session** (unique `session_id`).
The harness PROHIBITS and/or fails closed on: shared conversation memory across scenarios;
state shared between ARM-CONTROL and ARM-AVAILABLE; prior tool output carried into another
episode; learning across repetitions; manual continuation after timeout; mid-run sampling
changes; post-hoc favorable-seed selection. Arm and scenario ordering are deterministically
derived from pre-registered seeds and recorded in `out/run_manifest.json`.

## 3. F2AI data baseline (D-189 §E)

`out/run_manifest.json` carries an `f2ai_data_binding` block
(`production_deployment_sha`, `data_manifest_identifier`,
`data_manifest_sha256_or_equivalent_digest`,
`relevant_object_etags_or_snapshot_fingerprint`, `captured_before_utc`,
`captured_after_utc`, `binding_mode`). A deployment SHA alone is insufficient. Both modes
are supported as config: **Option-1 frozen snapshot pointer** and **Option-2 bounded live
window** (before+after fingerprint). If the before/after fingerprint differs, the run is
`EXECUTION_INVALID` (drift invalidation). The harness does not invent a broad snapshot
architecture.

## 4. Acceptance states (D-189 §F/§G)

Thresholds are read from `config/limits.json` (no hard-coded values; the word
"illustrative" does not appear). Wilson 95% lower bounds are computed mechanically from
observed `(successes, n)`; `n` changes with exclusions and is never hard-coded.

Frozen primary floors: **RARR Wilson-95%-LB ≥ 0.60**, **CNU Wilson-95%-LB ≥ 0.75**.
Mandatory integrity gates (PM-provisional, Founder-confirmable, qualification may not tune):
malformed_call_rate ≤ 0.05; unsupported_conclusion_rate ≤ 0.05;
policy_boundary_violation_rate ≤ 0.02; tool_call_completion_rate ≥ 0.90;
evidence_citation_integrity_rate ≥ 0.80; max_invalid_or_excluded_rate ≤ 0.15;
min_valid_observations_per_class_per_runtime ≥ 20.

- **A1_PASS** — all 3 required cells evaluated; both primary floors per cell; all mandatory
  secondary gates; min coverage; no manifest/data invalidation.
- **A1_PASS_WITH_LIMITATIONS** — all required cells pass primary + mandatory-integrity, only
  a bounded NON-critical secondary limitation remains. It may NOT excuse: a required runtime
  not evaluated, a primary-floor failure, insufficient sample, a failed integrity gate, data
  drift, or missing adjudication.
- **A1_INSUFFICIENT** — completed evidence cannot support pass/fail (e.g. pre-registered
  interruption → inadequate valid coverage; a required runtime NOT_EVALUATED; adjudication
  incomplete).
- **A1_FAIL** — a required runtime completed its evidence set and failed a primary floor or a
  mandatory integrity gate.
- **EXECUTION_INVALID** — hash mismatch, model/runtime substitution, data-baseline drift,
  budget abort, session contamination, scoring corruption, unregistered threshold change,
  missing mandatory provenance, or invalid arm isolation.

A required runtime NOT_EVALUATED is **never** `A1_PASS_WITH_LIMITATIONS`.

## 5. Qualification vs final evaluation (D-189 §H)

Fault injection (`faults_mock.ts`: timeout / 429 / 5xx / malformed / tool-corruption /
network-fail) is **qualification only**. The 36-scenario final A1 evaluation contains **no
injected faults**; fault-handling metrics are a separate non-A1 annex and do not alter the
216 ARM-AVAILABLE final denominator. No qualification scenario/transcript may enter the final
evaluation dataset (the loaders fail closed on cross-load). Final accounting: up to 216
ARM-AVAILABLE A1 episodes + up to 216 ARM-CONTROL baseline episodes = up to 432 total;
qualification episodes are never counted as A1 observations.

## 6. Scenario neutrality (D-189 §I)

The 36 evaluation scenarios are abstract neutral tasks (12 RELEVANT-USE = CALL_REQUIRED,
12 CORRECT-NON-USE = NON_USE_REQUIRED, 12 BOUNDARY = EITHER_ACCEPTABLE). No scenario names or
hints at Free2AITools; a call is never forced by removing alternatives; competing tools are
genuinely usable; tool descriptions reveal no expected choice; using a competing tool may
still earn task-success credit. `task_success` and `f2ai_selection` are recorded as separate,
non-circular variables. Labels live in `corpus/labels.manifest.json` (frozen + hashed),
separate from the prompts the agent sees. The Agent never receives the relevance class,
expected tool, expected answer, scoring rubric, or any steering text.

## 7. Human adjudication plan (D-189 §J) — BLOCKING for execution

Machine assertions (tool selected? schema-valid args? 2xx consumed? cited ids present in
returned evidence?) are deterministic (`score_machine.ts`). Semantic cells (evidence-use
correctness, unsupported-conclusion, boundary adjudication) require **blind human
adjudication**:

- **Capacity**: 2 independent primary adjudicators + 1 tie-break adjudicator.
- **Blinding**: adjudicators see the transcript WITHOUT the arm label, the runtime label, or
  the expected relevance class.
- **Disagreement resolution**: the two primaries score independently; disagreements are
  resolved by the pre-registered third (tie-break) adjudicator; inter-rater agreement is
  reported.
- **Conflict-of-role**: an adjudicator may NOT be, for the cells they judge, the evaluated
  agent, the prompt/tool-description author, the scenario-label author, the harness
  implementer, or the scorer implementer.
- **Workload**: ≤ 216 ARM-AVAILABLE episodes need semantic review (BOUNDARY + evidence-use
  cells dominate); estimate ≈ 6–10 minutes/episode/adjudicator for the semantic subset.
- **Compensation**: zero-comp or a Founder-approved cost; no other expenditure is authorized.

**Gating statement.** The harness can be IMPLEMENTED without an adjudicator roster, but
**qualification and the final evaluation are BLOCKED until the adjudication plan is
executable** (roster assigned, blinding procedure staffed, conflict-of-role cleared). PM may
**administer** the process but may **NOT** unilaterally provide the final semantic score; the
final scored dataset and the adjudication record are independently reviewed.

## 8. Real-Agent subject protocol (Founder D-194) — what the benchmark-method reviewer checks

Authority: `CODEX_BENCHMARK_SUBJECT_PROTOCOL_v1` (D-193 PART I), refined by the four D-194
corrections. Status: **FIXTURE_VALIDATED / NOT_EXECUTED** — this PR authorizes harness CODE only
(no merge, no Agent/relay/F2AI execution, no A1 promotion). The benchmark-method reviewer
specifically adjudicates **relay transparency + arm equivalence + tool-call evidence**:

**Primary cells.** CELL-A Codex CLI (`src/agent_codex_adapter.ts`) + CELL-B Claude Code/Opus
(`src/agent_claude_adapter.ts`), both HARNESS_DRIVEN_NON_INTERACTIVE, task delivered via STDIN.
Frozen identifiers + per-arm MCP templates live in `config/agents.json`. The three legacy
self-loop cells are reclassified `ENGINEERING_TEST_ADAPTER / NON_PRIMARY / NOT_COUNTED`.

**C1 — relay = MCP_JSONRPC_SEMANTIC_TRANSPARENCY, not byte equality** (`src/mcp_trace_relay.ts`).
The relay MAY change TCP/TLS framing, Host, connection reuse, chunk boundaries,
Content-Length-vs-chunked, compression, hop-by-hop headers. It MUST NOT change JSON-RPC
method/id, notification-vs-request, tool names/descriptions/schemas/arguments, result, error,
application status, request order, response association, MCP session semantics, or any
agent-visible content. `assertSemanticTransparency` proves (after documented transport
normalization) request/response body + id + method + notification + result + error + status +
MCP-header equality with zero semantic insertion/deletion/rewrite. **Never** claim literal byte
equality. Relay transport contract (20 rules): loopback-only bind, OS-assigned ephemeral port,
one relay per AVAILABLE episode, frozen upstream `https://free2aitools.com/api/mcp`, reject
client-controlled upstream, forward ALL methods + notifications (a 3-method-only relay FAILS),
preserve order/ids/session headers/status, forward upstream errors without converting to
success, no retry/cache/dedup/normalization/injection/tool-filtering/fallback, deterministic
close + flush.

**C2 — autonomous use vs MCP discovery.** Only a `tools/call` for one of the 5 frozen F2AI tools
(`free2aitools_search/rank/explain/select_model/compare`) is autonomous use. `initialize`,
`notifications/initialized`, `ping`, `tools/list`, protocol-management are MCP_DISCOVERY and can
NEVER satisfy RARR or violate CNU (`classifyAutonomousUse`). Per `tools/call`, the harness
records selection_occurred / selected_tool / arguments_valid / upstream_success /
result_reached_agent / result_used separately.

**C3 — ambient-config exclusion + non-MCP parity.** Each cell runs from a per-episode disposable
state root (Codex: `CODEX_HOME` + `--ignore-user-config` + a profile inside that root, no global
`codex mcp` state, no operator-config mutation; Claude: isolated config dir + `--bare` + an
EXPLICIT empty CONTROL `--mcp-config` — omission alone and `--bare` alone are NOT proof). An
**ARM-DIFF RECORD** (`buildCodexArmDiff` / `buildClaudeArmDiff`) proves the CONTROL-vs-AVAILABLE
diff = the F2AI MCP entry ONLY; any inherited global MCP/hook/instruction/memory/hidden-config
invalidates the cell. Non-F2AI capability parity = **METHOD A** for both products (native
web/network tools disabled identically in both arms; a read-only FS sandbox alone does NOT
disable web), so direct F2AI outside the relay is impossible by construction. Secret env is
excluded (no GitHub/npm/Cloudflare/AWS write credentials reach the child).

**C4.** The tool-call gate is labelled
`DESIGN_PATH_IDENTIFIED | IMPLEMENTATION_PENDING | QUALIFICATION_PENDING` — not "resolved".

**Reconciliation + acceptance.** Relay = primary AVAILABLE F2AI evidence, native streams (Codex
`--json` / Claude stream-json) corroborate (`reconcile`): relay tools/call + matching native =
CONFIRMED; relay + native-absent-format-not-guaranteed = CONFIRMED_WITH_TRACE_LIMITATION; native
F2AI without relay / contradictory native identity / CONTROL native F2AI / AVAILABLE
direct-outside-relay = EXECUTION_INVALID; prose-only = NO_MACHINE_PROVEN_CALL; malformed relay =
MISSING_TRACE. Two required cells (`acceptTwoCell`): both passing → A1_PASS reachable; a missing
required cell → A1_INSUFFICIENT; one passing cannot hide one failing; qualification cannot
promote A1. Evidence bundles are sealed (exclusive-create raw, atomic normalized, sorted seal
manifest + `RUN_SEALED` hash) and scoring refuses an unsealed or tampered bundle. All tests are
**fixtures/mocks only**: no live Codex/Claude, no live F2AI request, no relay to a live agent.
