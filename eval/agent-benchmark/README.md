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
config/   matrix.json  tools.json  limits.json        (hash-frozen; thresholds live in limits.json)
corpus/   evaluation.jsonl  qualification.jsonl  labels.manifest.json
src/      runner  manifest  schema_evidence
          host_ollama_direct  host_mcp_client  host_react_loop   (3 distinct agent loops)
          tools_f2a  tools_competing  faults_mock
          score_machine  score_aggregate
test/     neutrality  failclosed  scoring  antivacuity            (25 §L requirements)
```

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
npm test            # vitest run — 37 tests, no live call / no inference
```

## Gating

The harness can be implemented without an adjudicator roster, but **qualification and the
final A1 evaluation are BLOCKED** until the adjudication plan in `EVALUATOR_GUIDE.md` is
executable, the corpus/labels/promptset are frozen (SHA-256 recorded), the $0 cost cap is
confirmed, and a separate Founder execution ruling is issued. Merge disposition and
execution disposition are separate Founder gates.
