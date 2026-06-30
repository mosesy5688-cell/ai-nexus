# Free2AITools A1 Neutral-Agent Benchmark — HARNESS

Authority: Founder **D-189** (continuation of the D-170/D-171/D-188 return gate; base
design = `FREE2AITOOLS_DUAL_FRONTEND_PHASE4_NEUTRAL_AGENT_BENCHMARK_IMPLEMENTATION_GATE_PROPOSAL_v1_3`,
sections D1–D10, refined by the D-189 binding corrections C–J).

## What this is — and is NOT

This package is the **harness only**. D-189 authorizes implementation. It does **not**
authorize merge, execution, model inference, model download, outreach, or committing any
model-result evidence.

- A1 = **internal neutral-benchmark readiness**, not adoption. `A1_PASS != AGENT_ADOPTION_PROVEN`.
- The harness runs **out-of-band** (operator/manual). It NEVER runs in product required-CI.
- The test suite is **fixtures/mocks only**: no live Free2AITools request, no local-model
  inference, no external network call.
- `out/` (run manifest, transcripts, tool-call evidence, scores) is **gitignored** and never committed.

## Isolation

This is its own npm package with its own `package.json` + lockfile. Runtime dep: `zod`.
Dev deps: `typescript`, `tsx`, `vitest`, `@types/node`. The MCP client is a thin in-repo
JSON-RPC client (no external MCP dependency). Local Agent models are served by an
operator-installed Ollama daemon — an external binary, **never** an npm dep.

## Layout

```
config/   matrix.json  agents.json  tools.json  limits.json   (hash-frozen; thresholds in limits.json)
corpus/   evaluation.jsonl  qualification.jsonl  labels.manifest.json
src/      runner  manifest  schema_evidence
          host_ollama_direct  host_mcp_client  host_react_loop   (legacy engineering adapters)
          subject_runner  agent_codex_adapter  agent_claude_adapter  mcp_trace_relay  (D-194 real-Agent)
          tools_f2a  tools_competing  faults_mock
          score_machine  score_aggregate
test/     neutrality  failclosed  scoring  antivacuity           (legacy 25 §L)
          subject_adapter  mcp_trace_relay                       (D-194 40 §O + anti-vacuity)
```

## Real-Agent A1 cells — Founder D-194 (FIXTURE_VALIDATED / NOT_EXECUTED)

The A1 **primary** cells are now two **real Agents under neutral test**, driven
HARNESS_DRIVEN_NON_INTERACTIVE (the operator never converses per episode):

| cell | product | adapter | transport |
|------|---------|---------|-----------|
| CELL-A | Codex CLI | `src/agent_codex_adapter.ts` | MCP (via P6 relay) |
| CELL-B | Claude Code / Opus | `src/agent_claude_adapter.ts` | MCP (via P6 relay) |

The three legacy self-loop cells are **retained but reclassified** `ENGINEERING_TEST_ADAPTER` /
`NON_PRIMARY` / `NOT_COUNTED` (matrix.json `a1_primary:false`). `TRUE_PROVIDER_AND_AGENT_DIVERSITY
= BOUNDED_TO_TWO`.

- **P6 MCP trace relay** (`src/mcp_trace_relay.ts`): a local-loopback transport that forwards
  JSON-RPC to the **frozen** `https://free2aitools.com/api/mcp`. D-194 C1 =
  **MCP_JSONRPC_SEMANTIC_TRANSPARENCY** (transport framing may change; method/id/params/result/
  error/notification semantics may not). It **never** claims literal byte equality. AVAILABLE-arm
  only; absent from CONTROL. No add/remove/rewrite/inject/cache/retry/filter; forwards **all**
  methods + notifications; rejects any client-controlled upstream.
- **C2 use vs handshake**: only a `tools/call` for one of the 5 frozen F2AI tools is autonomous
  use. `initialize` / `notifications/initialized` / `ping` / `tools/list` are MCP_DISCOVERY and can
  **never** satisfy RARR or violate CNU (`classifyAutonomousUse`).
- **C3 ambient-config exclusion + METHOD A parity**: per-episode disposable state root
  (Codex `CODEX_HOME` + `--ignore-user-config` + profile-in-root; Claude isolated config dir +
  `--bare` + explicit empty CONTROL `--mcp-config`). An **ARM-DIFF record** proves CONTROL↔AVAILABLE
  differ **only** by the one F2AI MCP entry. Non-F2AI capability parity = **METHOD A** (native
  web/network disabled identically in both arms; a read-only FS sandbox alone does **not** disable
  web), so the only F2AI path is the relay.
- **C4**: the tool-call gate is labelled
  `DESIGN_PATH_IDENTIFIED | IMPLEMENTATION_PENDING | QUALIFICATION_PENDING` — **not** "resolved".
- **Acceptance** (`subject_runner.ts acceptTwoCell`): both required cells passing → `A1_PASS`
  reachable; Codex missing → `A1_INSUFFICIENT`; Claude missing → `A1_INSUFFICIENT`; one passing
  cannot hide one failing; legacy/optional cells cannot satisfy the required gate.
- **Model id fail-closed**: each cell's `MODEL_ID = UNRESOLVED_AT_EXECUTION_FREEZE`,
  `READY_FOR_RUN = false`; `assertModelResolved` rejects `codex`/`default`/`latest`/bare `opus`/
  empty/placeholder/unconfirmed ids. The PR defines the guard; it does **not** select a model.
- **Evidence**: unique gitignored `out/` run dir (FAIL if exists), exclusive-create raw artifacts,
  atomic normalized writes, a sorted seal manifest + `RUN_SEALED` hash; scoring refuses an unsealed
  or tampered bundle. **Fixtures/mocks only** — no live Codex/Claude, no live F2AI, no relay to a
  live agent in any test.

## Runtime matrix (3 required cells — material independence, Option A)

| cell | loop (host) | model family | transport |
|------|-------------|--------------|-----------|
| CELL-1 | single-shot tool-call (`host_ollama_direct.ts`) | Qwen2.5 | REST |
| CELL-2 | MCP agent loop (`host_mcp_client.ts`) | Llama-3.1 | MCP |
| CELL-3 | ReAct multi-turn (`host_react_loop.ts`) | Mistral | SDK |

Three **materially-distinct agent loops**, three **distinct model families**, one transport
each. The runner FAILS CLOSED if fewer than 3 required cells resolve. See `EVALUATOR_GUIDE.md`
for the independence argument the benchmark-method reviewer adjudicates.

## Acceptance states (frozen, pre-registered)

`A1_PASS` · `A1_PASS_WITH_LIMITATIONS` · `A1_INSUFFICIENT` · `A1_FAIL` · `EXECUTION_INVALID`.
A required runtime NOT_EVALUATED can never become `A1_PASS_WITH_LIMITATIONS` — it forces
`A1_INSUFFICIENT` (or `EXECUTION_INVALID`). Per-runtime primary rates are computed
separately; a pooled view is reported but never overrides a failing runtime.

## Verify (fixtures only)

```bash
cd eval/agent-benchmark
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 62 tests (legacy + D-194 real-Agent), no live call / no inference
```

## Gating

The harness can be implemented without an adjudicator roster, but **qualification and the
final A1 evaluation are BLOCKED** until the adjudication plan in `EVALUATOR_GUIDE.md` is
executable, the corpus/labels/promptset are frozen (SHA-256 recorded), the $0 cost cap is
confirmed, and a separate Founder execution ruling is issued. Merge disposition and
execution disposition are separate Founder gates.
