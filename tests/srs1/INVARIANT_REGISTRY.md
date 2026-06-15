# SRS-1 — Invariant Suite Central Registry (Tier-1, BLOCKING)

> **What this is.** SRS-1 is the consolidated, **hermetic**, **deterministic**
> invariant suite for Free2AITools. It is a permanent **BLOCKING PR gate**
> (Tier-1). This file is the **central registry**: a single map from each
> `gap/invariant ID -> assertion file -> protected behavior -> evidence class`.
> It is NOT a re-copy of the per-fix tests — it **references** the regression
> tests that already exist (so their logic is not duplicated) and adds hermetic
> tests only for invariants that were not yet covered.

## Tiering

| Tier | Suite | Trigger | Blocking? |
|------|-------|---------|-----------|
| **Tier-1 (this suite)** | SRS-1 hermetic invariant suite (all `tests/unit/*.test.ts` + `tests/srs1/*.test.ts`) | `pull_request` -> `unit-test` job in `.github/workflows/test-suite.yml` (`npx vitest run`) | **YES — required, blocks merge** |
| Tier-2 | SRS-2A frontend Playwright baseline (`tests/e2e/srs2a-frontend-baseline.spec.ts`) | post-deploy `workflow_run` + daily cron | NO — informational, `continue-on-error: true`, never a PR check |

**Hermetic boundary (Founder, hard):** no live network, no production dependency,
no duplicated product LOGIC (every assertion reads repo SOURCE/CONFIG @ `main`,
never re-implements the behavior), no screenshot-only assertion, no
timing-sensitive assertion. Run 3+ times -> identical results (see determinism
proof in the PR body).

## Evidence classes

- **SOURCE** — asserts on the literal source of a route/handler/page/util.
- **CONFIG** — asserts on a static config artifact (OpenAPI JSON, mcp.json, sitemap, `_redirects`, llms template).
- **EXEC** — executes the real shared module with a mock seam (no network) and asserts behavior.
- **STRUCT** — asserts a filesystem-routing structural fact (route file present/absent ⇒ reachable/404/410).

---

## Registry — G-series (shipped honest-contract / route fixes)

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| G-01 | Genuine entity-404 body has NO future-availability copy; 404/503 stay distinct | `tests/unit/entity-not-found-honesty.test.ts` | SOURCE | **REUSED** |
| G-03 | Search OpenAPI `limit` max == 20 == runtime `FREE_TIER_MAX` | `tests/unit/openapi-stats-nullable.test.ts` (+ `tests/srs1/openapi-route-parity.test.ts` re-locks) | CONFIG | **REUSED** + added re-lock |
| G-04 | `CompareResponse.fni_factors.semantic` nullable (matches compare.ts null) | `tests/unit/openapi-stats-nullable.test.ts` (+ `tests/srs1/openapi-route-parity.test.ts`) | CONFIG | **REUSED** + added re-lock |
| G-05 | MCP `select_model` maps transient 503 -> `isError` (not laundered) | `tests/unit/mcp-status-propagation.test.ts` (EXEC) + `tests/srs1/negative-contract.test.ts` (SOURCE) | EXEC + SOURCE | **REUSED** + added source-lock |
| G-06 | Reports 410 pages link `/trends` not nonexistent `/trending`; no auto meta-refresh | `tests/unit/retired-route-cleanup.test.ts` | SOURCE | **REUSED** |
| G-07 | `sitemap-static` does not advertise retired `/reports` | `tests/unit/retired-route-cleanup.test.ts` (+ `tests/srs1/retired-surface.test.ts` allow-list) | CONFIG | **REUSED** + added allow-list lock |
| G-08 | Onboarding CTA -> `/tools` not retired `/agent` | `tests/unit/retired-route-cleanup.test.ts` | SOURCE | **REUSED** |

> G-02 is covered transitively by the G-01 / detail-route 404-vs-503 distinctness assertions in `entity-not-found-honesty.test.ts` (no separate file).

## Registry — P-series (shipped surface/security fixes)

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| P-01 | Fallback image refs resolve to a tracked existing asset (no dead `default-model.jpg`) | `tests/unit/fallback-image-resolves.test.ts` | SOURCE + STRUCT | **REUSED** |
| P-02 | `leaderboard.astro` redirect-only -> `/benchmarks`; not in sitemap | `tests/unit/leaderboard-retirement.test.ts` (+ `tests/srs1/retired-surface.test.ts`) | SOURCE + CONFIG | **REUSED** + added sitemap allow-list |
| P-03 | leaderboard reads no `/cache/benchmarks`, fabricates no `new Date()` freshness | `tests/unit/leaderboard-retirement.test.ts` | SOURCE | **REUSED** |
| P-04 | Knowledge fallback has no "being aggregated"/future-availability copy | `tests/unit/knowledge-fallback-honesty.test.ts` | SOURCE | **REUSED** |
| P-05 | `concepts` + `trends/batch` declared in OpenAPI, conform to runtime envelope | `tests/unit/openapi-concepts-trends.test.ts` | CONFIG | **REUSED** |
| P-06 | `vfs-metadata` route file ABSENT (no public 501 stub); provider util kept | `tests/unit/vfs-metadata-route-removed.test.ts` | STRUCT | **REUSED** |
| P-07 | 4 diag routes (`diag`/`db-diag`/`bundle-diag`/`vfs-debug`) ABSENT (never re-public) | `tests/unit/diag-endpoint-public-denial.test.ts` | STRUCT | **REUSED** |
| P-08 | `/api/v1/health` route + OpenAPI consistent (NO_GAP) | `tests/srs1/openapi-route-parity.test.ts` | STRUCT + CONFIG | **NEW** |
| P-09 | redirect authority is astro.config/SSR not dead `_redirects` | `tests/srs1/redirect-authority.test.ts` | CONFIG + STRUCT | **NEW** |

## Registry — MCP / OpenAPI / negative-contract / retired (cross-cutting)

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| MCP-SET | `mcp.ts` TOOLS = exactly 5 tools (search/rank/explain/select_model/compare); static `mcp.json` = SAME 5-tool set (set parity) | `tests/srs1/mcp-tool-set-parity.test.ts` | SOURCE + CONFIG | **NEW** |
| NEG-MCP | `mcp.ts` SERVER_BOUNDARY carries the "no select/decide/recommend, no live semantic/ANN" NOT-section; surfaced as initialize.instructions | `tests/srs1/negative-contract.test.ts` | SOURCE | **NEW** |
| NEG-RANK | ranking comparator reads ONLY `params_billions` + `fni_score`; no payment/sponsor/tier token (field-scope static lock; behavior in c4 canary) | `tests/srs1/negative-contract.test.ts` | SOURCE | **NEW** (complements `tests/unit/c4-anti-arbitration.test.ts` EXEC) |
| NEG-DOCS | `llms.txt` template + `developers.astro` carry the NOT-section | `tests/srs1/negative-contract.test.ts` | SOURCE/CONFIG | **NEW** |
| OAS-PARITY | declared `/api/v1/*` OpenAPI path set === live route-file set (both directions, no drift) | `tests/srs1/openapi-route-parity.test.ts` | CONFIG + STRUCT | **NEW** |
| OAS-CAPS | search `limit` max 20 + `CompareResponse.semantic` nullable re-locked at route-parity tier | `tests/srs1/openapi-route-parity.test.ts` | CONFIG | **NEW** re-lock (field enumeration REUSED from `openapi-stats-nullable.test.ts`) |
| RETIRE-SITEMAP | static sitemap advertises NO retired/410/redirect route (allow-list lock) | `tests/srs1/retired-surface.test.ts` | CONFIG | **NEW** |
| RETIRE-410 | retired entity types `/agent`,`/space`,`/prompt` detail pages set 410 (not 200/404) | `tests/srs1/retired-surface.test.ts` | SOURCE | **NEW** |

## Registry — P3-EVIDENCE (citation integrity)

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| DJ-W02 | Producer `normalizeCitation` never fabricates: no `[object Object]`, no id/slug/hash/placeholder-as-title, no empty field shells, no current/bake-year substitution; title MANDATORY (no genuine title ⇒ `citation` null); author/year/url omitted-not-shelled when absent | `tests/unit/citation-integrity.test.ts` (EXEC, 18 reqs/22 cases) | EXEC | **NEW** |

> Production-tier complement (NOT a hermetic PR test — the packer never runs in CI): the bake canary
> `verifyCitationIntegrity` (`scripts/factory/lib/verify-canaries.js`, wired in `scripts/factory/verify-db.js`)
> re-scans every `meta-NN.db` shard at bake time and fail-louds on the same fabrication classes (year judged
> against the packed source `published_year`, never a current-year blacklist). SRS-1 holds the hermetic logic
> guard; the canary holds the artifact guard.

## Registry — P3-DX-1 (developer-journey reference integration)

> Deterministic documentation/reference invariants only. Live-catalog freshness
> stays informational (the §15 read-only live verification), never a blocking PR
> assertion — these locks read repo SOURCE/CONFIG and execute the shipped JS/
> Python snippets against a local in-process mock (no network, no prod).

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| DJ-R1 | No retired/stale catalog id (incl. P3-0 Meta-Llama forms + README badge form) appears in any shipped executable example or machine field across developers.astro / README / llms-template / mcp.json | `tests/srs1/dx-reference-examples.test.ts` | SOURCE/CONFIG | **NEW** |
| DJ-R2 | Primary entity/compare examples are search-derived (ids read back from results), not fixed-catalog-id; fixed forms are explicitly placeholder/illustration-marked | `tests/srs1/dx-reference-examples.test.ts` | SOURCE | **NEW** |
| DJ-R3 | Documented routes/links exist in the route/contract inventory (/developers→/openapi.json, search/compare/entity/mcp.json/api-mcp); llms.txt + README point at /developers + /openapi.json | `tests/srs1/dx-reference-examples.test.ts` | STRUCT + CONFIG | **NEW** |
| DJ-R4 | The curl/JS/Python snippets asserted are the EXACT ones shipped in developers.astro (extracted from the .astro via `dx-snippet-extract.ts`, not test-only copies); each is base-URL-configurable | `tests/srs1/dx-reference-examples.test.ts` | SOURCE | **NEW** |
| DJ-R5 | Shipped JS snippet parses and behaves correctly against a mock: success/zero-results/400/404/429+Retry-After/503-exhaust/500; null preserved; ids reused | `tests/srs1/dx-reference-behavior.test.ts` | EXEC | **NEW** |
| DJ-R6 | Shipped Python snippet compiles (py_compile) + carries required status/retry/null-safe constructs; where `requests` is installable, executes against the mock (success + null preserved) | `tests/srs1/dx-reference-behavior.test.ts` | EXEC | **NEW** |
| DJ-R7 | New flow carries no autonomous-verdict/recommendation/router language; restates caller-decides; REST-vs-MCP chooser stays neutral (no MCP-preferred / REST-legacy / F2AI-routes) on developers.astro + llms.txt | `tests/srs1/dx-reference-examples.test.ts` | SOURCE/CONFIG | **NEW** |

> Files: `dx-reference-examples.test.ts` (static R1-R4/R7), `dx-reference-behavior.test.ts`
> (behavioral R5/R6), and shared extractor `dx-snippet-extract.ts` (split to honor the
> CES 250-line monolith ban).

> The R6 python execution is conditional (`it.runIf(requests-importable)`); the
> compile + construct lock is unconditional, so the invariant never silently
> no-ops where `requests` is absent. The mock-server R5/R6 runs use async
> `execFile` (so the in-process server stays serving) and bypass any sandbox
> HTTP(S)_PROXY for the loopback target (harness-only env; the snippet is run
> verbatim).

## Registry — P3-CONTRACT-1 (machine-contract parity)

> Deterministic, hermetic CONTRACT-PROJECTION locks: the served machine contracts
> (OpenAPI prose+schema, MCP static manifest) must match the currently-implemented
> public runtime. Most rows read repo SOURCE (search.ts / v1/search.ts / mcp.ts /
> openapi.json.ts / entity-projection.ts) + parse static JSON. DJ-R11 additionally
> invokes the openapi.json.ts route GET (cloudflare:workers mocked, manifest lookups
> try/catch to a deterministic fall-through) to assert the ACTUAL transformed OpenAPI
> output — because the served `/api/v1/search` description is overwritten by that
> transform and a static-schema-only assertion cannot catch the projection (D-42).
> ZERO runtime/behavior assertion — they lock the PROJECTION, so a drift either way fails the gate.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| DJ-R05 | Search result-limit prose ⇄ schema ⇄ runtime all == 20: openapi.json.ts both wordings + schema `limit.maximum` + runtime `FREE_TIER_MAX` | `tests/srs1/machine-contract-parity.test.ts` | SOURCE + CONFIG | **NEW** |
| DJ-R06 | `SearchResponse` schema field set == ACTUAL public-v1 200 response, DERIVED from search.ts DISPLAY_COLS + respond() + v1/search.ts transforms (fni_s nulled + fni_s_note added; `_dbSort`/`_score`/`_source` stripped) — non-circular, no internal/underscore field, nullability annotated, `total_count` required | `tests/srs1/machine-contract-parity.test.ts` | SOURCE + CONFIG | **NEW** |
| DJ-R10 | Search pagination contract: documented params (q,type,limit,page) == handler acceptance; `page` 1-based/default 1/min 1, offset=(page-1)*limit | `tests/srs1/machine-contract-parity.test.ts` | SOURCE + CONFIG | **NEW** |
| DJ-R11 | SERVED `/api/v1/search` description (the openapi.json.ts TRANSFORM OUTPUT, not the raw static schema) carries pagination semantics (1-based `page`, default 1, offset=(page-1)*limit, total_count) + the consistency caveat (results change on refresh; no cursor/snapshot consistency), while preserving catalog purpose + max-20 + transient-503 note (never reverts to "up to 5"). Pattern B: openapi.json.ts is the sole authoritative owner of the served description; the static schema holds a non-divergent pointer. D-42: a caveat written only into the static schema is silently discarded by the transform — the test invokes the route GET so a future drift cannot disappear during projection. | `tests/srs1/machine-contract-parity.test.ts` | EXEC + CONFIG | **NEW** |
| DJ-M02 | MCP static `mcp.json` search `type` enum == dynamic `mcp.ts` inputSchema enum (both include `benchmark`, a served entity type) | `tests/srs1/machine-contract-parity.test.ts` | SOURCE + CONFIG | **NEW** |
| DJ-W05 | `EntityResponse.entity` declares `id` + `canonical_id` (same-value, projected `canonical_id: e.id`, both required/non-null) and NO top-level `umid`; no "id IS umid" equivalence in the machine contract | `tests/srs1/machine-contract-parity.test.ts` | SOURCE + CONFIG | **NEW** |
| P3C-NONEXP | No capability expansion under the contract-parity PR: MCP still exactly 5 tools (static+dynamic); OpenAPI path set unchanged (10 endpoints) | `tests/srs1/machine-contract-parity.test.ts` | SOURCE + CONFIG | **NEW** |

---

## P-09 — added at post-P-09 rebase (merge order: P-09 -> SRS-1)

- **P-09 redirect-authority end-state** was intentionally deferred out of the
  initial SRS-1 PR because it changed during the P-09 cleanup PR (merged to main
  as `e2f46911`). PM merge order **P-09 -> SRS-1** was honored: SRS-1 was rebased
  onto post-P-09 main and the redirect-authority invariant
  (`tests/srs1/redirect-authority.test.ts`, row P-09 above) added then. It pins
  the *authority shape* (adapter `redirects:` map + SSR pages are live; the dead
  `public/_redirects` FILE is deleted), complementing the per-fix regression guard
  `tests/unit/redirect-authority-cleanup.test.ts` (logic not duplicated).

## Reused vs newly added — summary

- **REUSED (referenced, logic not duplicated): 14 invariants** — G-01, G-03, G-04,
  G-05, G-06, G-07, G-08, P-01, P-02, P-03, P-04, P-05, P-06, P-07 (their
  per-fix tests under `tests/unit/` remain the source of truth; SRS-1 points at
  them and, where useful, adds a thin cross-tier re-lock).
- **NEW hermetic tests added (gaps not previously covered): 9 invariants** — P-08,
  P-09, MCP-SET, NEG-MCP, NEG-RANK, NEG-DOCS, OAS-PARITY, OAS-CAPS, RETIRE-SITEMAP,
  RETIRE-410 — in 5 files under `tests/srs1/`.
- **NEW invariant (P3-EVIDENCE-1): DJ-W02** — hermetic EXEC assertion in
  `tests/unit/citation-integrity.test.ts` (collected by the same Tier-1 `unit-test` gate),
  complemented by the bake-time `verifyCitationIntegrity` canary (artifact tier, not a PR test).

## How SRS-1 is wired as the blocking gate

The Tier-1 suite runs through the **existing required `unit-test` job** in
`.github/workflows/test-suite.yml`, which executes `npx vitest run` on every
`pull_request` to `main`. `vitest.config.ts` includes `**/*.{test,spec}.ts`, so
both `tests/unit/*` (reused) and the new `tests/srs1/*` files are collected
automatically — no separate runner. A red SRS-1 assertion fails `unit-test`,
which blocks the merge. SRS-2A (Tier-2) is a separate, non-blocking,
post-deploy workflow and is never a PR check.
