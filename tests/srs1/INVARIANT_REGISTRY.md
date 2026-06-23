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
| DJ-W02b | STAGE-B FINAL citation authority at the PACK CHOKEPOINT: `buildEntityRow` (the single point every entity is written into the 96 meta-NN.db) RE-DERIVES the packed `citation` via the shared `normalizeCitation` — a raw/stale `e.citation` (id/slug/hash-as-title or empty shell) NEVER passes through; degenerate inputs pack as SQL NULL; over-long derived citations truncate to the 500-char column budget. Proven both as a unit boundary AND a mini-pack: entities built through `buildEntityRow` into the authoritative `entitiesTableSql` in-memory SQLite, then the packed `citation` column is queried back. | `tests/unit/citation-chokepoint.test.ts` (EXEC, 16 cases) | EXEC | **NEW** |
| DJ-W02c | STAGE-B VFS-PACK CACHE VERSIONING: a frozen `VFS_PACK_CODE_VERSION` token scopes EVERY `intra-4-4-vfs-pack` cache key + restore-prefix (no bare/cross-version prefix); a fresh pack stamps `output/meta/vfs-pack-code-version.txt`; skip-pack requires ALL of meta>=20 AND mesh graph AND sentinel==version; missing/mismatched sentinel OR `force_fresh` forces compute; fused/embedding/baked caches keep their own keys (warm reuse preserved, only packed rows rebuild). | `tests/unit/vfs-pack-cache-version.test.ts` (CONFIG/SOURCE, 11 cases) | CONFIG + SOURCE | **NEW** |
| DJ-W02d | STAGE-B ABSOLUTE INTERNAL-URL CANARY (D-59): the bake canary's relative-route/"by Free2AITools" residue check did NOT catch an ABSOLUTE `url={https://[*.]free2aitools.com/...}` (the 96/96-shard live baseline measured ~99.99% of served citations carrying one, silently passed). New zero-tolerance gate `Citation: no internal Free2AITools URL` (counter `internalUrl`): rejects http/https, case-insensitive, host `free2aitools.com` or any subdomain, inspecting ONLY the `url={...}` field (a domain in title/note never false-positives); genuine external urls (arxiv/github/hf) pass. Pure predicate `citationHasInternalUrl` exported. Threshold 0; existing residue checks retained. | `tests/unit/citation-internal-url-canary.test.ts` (EXEC, 15 cases incl. full-corpus gate) | EXEC | **NEW** |

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

## Registry — P3-CONTRACT-1 PR-B (public honesty & discovery)

> Deterministic, hermetic DOCUMENTATION / CONTRACT-PROJECTION locks on the
> human-facing public surfaces. They read repo SOURCE/CONFIG only (no live
> fetch, no behavior assertion) and pin the corrected public wording to the
> currently-implemented truth so a future drift back to an over-claim fails the
> gate. ZERO business-logic / producer / serving-semantics dependency.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| T6 (DJ-W01) | methodology.astro Pillar-1 states what exists now (`source`/`source_url`), explicitly says a complete machine-readable `source_trail` is NOT publicly exposed, preserves the PLANNED evidence-chain ambition, promises no raw-snapshot/timestamp/content-hash current field, carries the no-fabrication contract; retired "complete audit trail / every input is traceable" claim gone | `tests/srs1/public-honesty.test.ts` | SOURCE | **NEW** |
| T7 (DJ-D02) | README current-product wording (headline :5 + Cross-source catalog bullet) lists only served types (models/datasets/papers/tools/benchmarks), carries NO cancelled type (agent/space/prompt) and NO ungrounded platform count ("13+"/"NN+ platforms"); keeps daily-cadence + FNI clause + factual platform names + "and more" | `tests/srs1/public-honesty.test.ts` | CONFIG | **NEW** |
| T8 (DJ-D03) | sitemap-static STATIC_PAGES INCLUDES `/developers` (discoverable), no duplicates, same-host (built from BASE_URL), retired/410/redirect routes stay excluded | `tests/srs1/public-honesty.test.ts` | CONFIG | **NEW** |
| T-IDENTITY (DJ-W05 human) | developers.astro distinguishes `id` / `canonical_id` / `umid`; NO "id field ... is your UMID" equivalence; states UMID is a separate derived digest callers need not compute | `tests/srs1/public-honesty.test.ts` | SOURCE | **NEW** |
| T-PMC-BOUNDARY | corrected PR-B wording preserves the identity sentence (Footer, untouched) + caller-decides negative contract (developers.astro); the touched UMID/pagination blocks introduce no recommend/router/verdict language | `tests/srs1/public-honesty.test.ts` | SOURCE | **NEW** |

> C3 (human pagination note in developers.astro) is the human-prose mirror of the
> machine-contract DJ-R10/DJ-R11 pagination invariants (PR-A,
> `machine-contract-parity.test.ts`); the page/total_count semantics it documents
> are read directly from the shipped `src/pages/api/search.ts` handler (1-based
> `page`, default 1, `total_count` in `respond()`), so the prose matches runtime.

---

## Registry — P2-TELEMETRY-TA1 (adoption-telemetry substrate & constitutional isolation)

> Deterministic, hermetic SUBSTRATE invariants for the P2 Adoption Telemetry
> Phase-A TA1 (Founder gate D-2026-0615-49). TA1 ships the AE write adapter +
> closed-world schema/vocab + classifiers + default-OFF flag + local no-op mock +
> the no-read/binding-confinement static gate. NO call-site instrumentation
> (TA2), NO prod writes, telemetry DEFAULT-OFF. North-star: "P2 measures
> dependence; it does not monetize, rank, recommend, or gate." These tests read
> repo SOURCE + execute the shared telemetry modules with a mock binding (no
> network, no prod, no AE write). The static gate is the BLOCKING co-deliverable.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| TEL-SCHEMA | Closed-world event schema: EXACTLY {schema_version, surface, operation/tool, status_class(2xx\|3xx\|4xx\|5xx), cache_class, audience_class, referer_host_class, time_bucket}; 302->3xx (Erratum #4); operation = tool name ONLY for mcp.tools_call; any unknown/extra key rejected; classifiers return only closed classes (undecidable -> unknown) | `tests/srs1/telemetry-schema.test.ts` | EXEC + SOURCE | **NEW** |
| TEL-PRIVACY | Every FORBIDDEN field name (latency/deployment-SHA/snapshot/body/arguments/query/prompt/entity-id/slug/path/canonical_id/UMID/source-url/raw-ip/raw-UA/raw-referer/cookie/fingerprint/geo/clientInfo/error) is rejected before reaching the sink; the written AE data point carries ONLY the 8 closed-enum dimensions (<=20 blobs, 0 doubles, EXACTLY 1 index); emit() never accepts Request/URL/body | `tests/srs1/telemetry-privacy.test.ts` | EXEC | **NEW** |
| TEL-ISOLATION | DEFAULT-OFF (flag != 'true' -> no write); no-binding no-op (no write, no throw); failure isolation (throwing sink never throws into caller; lost-write meta-counter increments); waitUntil fire-and-forget; emit returns no serving value; telemetry modules import nothing from FNI/ranking/search/projection/MCP-response | `tests/srs1/telemetry-isolation.test.ts` | EXEC + SOURCE | **NEW** |
| TEL-GATE | The no-read + binding-confinement static gate (`scripts/check-telemetry-no-read.mjs`) is green AND non-vacuous: binding `ADOPTION_TELEMETRY` confined to the textual allowlist (config + env-type + adapter + mock + gate + telemetry tests); the 13 serve/scoring/projection/ranking/MCP-response no-read paths exist and never name the binding (RUNTIME dereference allowlist = the single write adapter only) | `tests/srs1/telemetry-isolation.test.ts` | EXEC + STRUCT | **NEW** |

## Registry — WO-3-A1 (arXiv OAI transport recovery core)

> Deterministic, hermetic EXEC invariants for WO-3-A1 (Founder D-2026-0616-65,
> amended by the D-2026-0616-67 code-review fix of 5 blockers).
> They drive the real `ArXivAdapter.fetchOAI` through an injected `fetchWithTimeout`
> seam + a zeroed/injected clock+backoff seam (`{ now, sleep }`) so no live network
> and no real sleep ever occur. The single-arbiter ACTIVE-transport budget
> (`ArxivRecoveryState`) + OAI envelope/structure parser (`arxiv-oai-client.js`) are
> the system under test. Scope is TRANSPORT RECOVERY ONLY: `normalize()`, ar5iv
> enrichment, and relation derivation are NOT exercised or changed. Files:
> `tests/unit/harvest-arxiv-recovery.test.ts`, `tests/unit/harvest-arxiv-terminal-meta.test.ts`
> (+ existing `tests/unit/harvest-fail-loud.test.ts`, reused for the FetchError taxonomy).

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| WO3A1-SAMETOKEN | A failing resumption page RETAINS its EXACT resumptionToken and retries the SAME token (URL identity asserted) within the single budget; the page is accepted EXACTLY once; the token advances ONLY after a complete valid page; no dup/no miss | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **REUSED** |
| WO3A1-NOWINDOW | **NEGATIVE invariant**: on a resumption-page timeout the token is NEVER reset to null and NO fresh first-page/window-origin query is issued (every post-first fetch carries the SAME token; no `metadataPrefix` re-query). The old `resumptionToken = null; continue;` window-restart is IMPOSSIBLE | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **REUSED** |
| WO3A1-EXHAUST | Same token timing out to the per-token limit (3 requests = initial + 2 retries) -> terminal PAGE_TIMEOUT_EXHAUSTED (FetchError kind=abort); partial yield NOT healthy (throws); token NOT cleared; exactly ONE bare first-page query ever issued | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **REUSED** |
| WO3A1-OAIERR | OAI `<error>` envelope parsed BEFORE records/next-token/clean-end (HTTP 200): badResumptionToken -> BAD_RESUMPTION_TOKEN fail-loud; badArgument/unknown -> OAI_ERROR fail-closed; initial noRecordsMatch -> clean-zero []; resumption noRecordsMatch -> fail-loud; an envelope is NEVER a clean completion | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **REUSED** |
| WO3A1-CORRECT | Correctness terminals: malformed XML -> MALFORMED_XML (kind=parse); next-token cycle A->B->A -> TOKEN_CYCLE; zero unique progress across the window -> NO_PROGRESS; genuinely-empty first page -> [] success; healthy output structure parity | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **REUSED** |

### D-2026-0616-67 amendment — 5-blocker code-review fix (14 added tests)

> The budget is now a TRUE ACTIVE-TRANSPORT accumulator (`transportActiveMs`):
> ONLY the fetch+read/parse+structure+validation span (`startSpan()`..`endSpan()`)
> + arbiter-owned retry/backoff waits are charged; the 250ms spacing, the 20s
> inter-page pacing and `enrichBatch()` run OUTSIDE any span and never consume it.
> `TOTAL_BUDGET_MS` = 6300000 (active-transport ceiling for a ~60-page walk @ 90s
> worst-case tail + bounded retries; the old 600000ms wall-clock ceiling that
> counted pacing+enrichment is retired). Per-request timeout = `min(120000,
> remaining transport budget)`.

| ID | Protected behavior (blocker) | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| WO3A1-A-BUDGET | **BLOCKER A**: a 60+ page healthy walk COMPLETES with 20s pacing + simulated enrichment wall time PRESENT but EXCLUDED from the budget (T1); enrichment + pacing do NOT consume the active-transport budget (T2); request timeout = min(120000, remaining budget) (T3); cumulative active-transport exhaustion -> TOTAL_BUDGET_EXHAUSTED fail-loud (T4) | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **NEW** |
| WO3A1-B-STRUCT | **BLOCKER B**: tokened response missing `<ListRecords>` -> fail-loud, NEVER COMPLETE (T5); initial missing `<ListRecords>` node -> MALFORMED_XML fail-loud (T6); initial PRESENT empty `<ListRecords>` (zero records) -> clean-zero [] (T7) | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **NEW** |
| WO3A1-C-ARBITER | **BLOCKER C**: 403/429/503 retries remain SAME-token + stop at <=3/token (4th impossible) and `BaseAdapter.handleRateLimit` is NEVER called (T8); Retry-After is arbiter-executed via the sleep seam + budget-charged (T9) | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **NEW** |
| WO3A1-D-PROGRESS | **BLOCKER D**: valid non-target-category but raw-advancing pages do NOT fire false NO_PROGRESS (T10); a replayed raw page (same raw ids, fresh token text) -> NO_PROGRESS (T11); token-cycle rejection occurs BEFORE `enrichBatch` + before the seenIds commit (enrich NOT called on the cycle page) (T12) | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **NEW** |
| WO3A1-E-EVIDENCE | **BLOCKER E**: a FetchError's structured recovery metadata (terminal/acceptedPages/totalRetries/uniqueIds/elapsedTransportMs/tokenFingerprint) flows into the EXISTING `terminal_meta` sidecar field, recorded as a HARD FAILURE (status=failed/timeout, never success/partial) (T13); abort meta merges with `timeout_kind=request_timeout` | `tests/unit/harvest-arxiv-terminal-meta.test.ts` | EXEC | **NEW** |
| WO3A1-PARITY | T14: existing healthy multi-page parity unchanged (same-token retry once then succeeds -> exact yield, same-token identity) | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **NEW** |

### D-2026-0616-68 amendment — 2-blocker narrow fix (5 added tests)

> Two narrow correctness blockers remained after the D-67 5-blocker fix.
> **Blocker 1 (invalid-page zero-mutation):** `acceptPage()` is now TWO-PHASE — a
> PURE validate phase evaluates NO_PROGRESS (on the candidate window, computed
> WITHOUT pushing) and TOKEN_CYCLE (token identity) and RETURNS the terminal
> BEFORE any mutation; a COMMIT phase (fingerprint add / window push /
> lastProgressAt / acceptedPages++ / acceptedUniqueIds / tokenHistory push) runs
> ONLY after validation passes. A rejected cycle/stall page leaves ZERO partial
> arbiter state, so `snapshot().acceptedPages` and `terminal_meta.acceptedPages`
> exclude it. **Blocker 2 (budget beats page-timeout):** after a request
> failure/abort (and after a refused retry-wait), BUDGET precedence is applied in
> BOTH the `fetch` and `http` branches: `budgetExhausted()` (clipped-timeout abort
> drove `endSpan` to ~0) -> TOTAL_BUDGET_EXHAUSTED; else attempts exhausted
> (`canRetryToken()` false) -> PAGE_TIMEOUT_EXHAUSTED (abort) / FETCH_ERROR; else a
> retry-wait that cannot FIT the remaining budget (`executeRetryWait` now refuses
> budget-vs-attempts distinctly, charging nothing) -> TOTAL_BUDGET_EXHAUSTED; else
> retry SAME token. PAGE_TIMEOUT and TOTAL_BUDGET are never conflated.

| ID | Protected behavior (blocker) | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| WO3A1-INVALID-ZEROMUT | **BLOCKER 1**: a rejected TOKEN_CYCLE page mutates NOTHING — acceptedPages/acceptedUniqueIds/fingerprint-set/progressWindow/tokenHistory/lastProgressAt all identical to the pre-cycle snapshot; `snapshot().accepted_pages` and `terminalError().meta.acceptedPages` carry the PRE-cycle count (CYCLE-ZEROMUT); a rejected NO_PROGRESS stall page is likewise pure (no extra window-0 pushed, pages unchanged) (NOPROG-ZEROMUT); end-to-end `terminal_meta.acceptedPages` EXCLUDES the cycle page + the cycle page is NEVER enriched/committed (CYCLE-META) | `tests/unit/harvest-arxiv-budget.test.ts` | EXEC | **NEW** |
| WO3A1-BUDGET-PRECEDENCE | **BLOCKER 2**: when the per-request timeout is clipped to the remaining budget and the request aborts at that clipped timeout (endSpan drives remaining to ~0), terminal is TOTAL_BUDGET_EXHAUSTED, NOT PAGE_TIMEOUT_EXHAUSTED (BUDGET-i); with ample budget, three full 120s same-token aborts (attempts exhausted, budget remaining) -> PAGE_TIMEOUT_EXHAUSTED (BUDGET-ii); a Retry-After/backoff wait that cannot fit the remaining budget -> TOTAL_BUDGET_EXHAUSTED (BUDGET-precedence). The two terminals are never conflated | `tests/unit/harvest-arxiv-budget.test.ts` | EXEC | **NEW** |

### D-2026-0616-69 amendment — parse-branch budget precedence (final narrow fix, 5 tests)

> The D-68 BLOCKER 2 budget precedence was applied in the `http` and `fetch` branches
> but NOT the `parse` (MALFORMED_XML) branch, which still short-circuited
> `if (canRetryToken() && executeRetryWait()) continue; else MALFORMED_XML` — conflating a
> budget-refused retry-wait with a parse-attempts-exhausted terminal. The `parse` branch is
> now made IDENTICAL to the `fetch` branch: (1) `budgetExhausted()` -> TOTAL_BUDGET_EXHAUSTED;
> (2) `canRetryToken()` true but `executeRetryWait()` refuses (full wait cannot fit remaining
> budget) -> TOTAL_BUDGET_EXHAUSTED; (3) parse attempts exhausted while budget remains ->
> MALFORMED_XML. Budget-refusal classification is now consistent across all three retryable
> branches (http/fetch/parse). MALFORMED_XML stays kind `parse`; TOTAL_BUDGET_EXHAUSTED stays
> kind `abort` (unchanged `TERMINAL_KIND` map). TAXONOMY: the implementation has COMPLETE +
> **NINE** fail-loud terminals — BAD_RESUMPTION_TOKEN, OAI_ERROR, PAGE_TIMEOUT_EXHAUSTED,
> TOTAL_BUDGET_EXHAUSTED, MALFORMED_XML, NO_PROGRESS, TOKEN_CYCLE, FETCH_ERROR,
> **RATE_LIMIT_EXHAUSTED** (the last previously omitted from prose enumerations).

| ID | Protected behavior (blocker) | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| WO3A1-PARSE-BUDGET-PRECEDENCE | **PARSE-BRANCH PRECEDENCE**: a parse failure whose request consumed the remaining budget (endSpan drives remaining to ~0) -> TOTAL_BUDGET_EXHAUSTED, NOT MALFORMED_XML (PARSE-BUDGET-i); a parse retry-wait that cannot fit the remaining budget (`executeRetryWait` refuses) -> TOTAL_BUDGET_EXHAUSTED (PARSE-BUDGET-ii); 3 same-token parse failures with ample budget (attempts exhausted) -> MALFORMED_XML (PARSE-ATTEMPTS); FetchError.kind + terminal_meta.terminal correct across all three (TOTAL_BUDGET_EXHAUSTED -> abort; MALFORMED_XML -> parse) (PARSE-KIND); the existing single-shot MALFORMED_XML fail-loud (kind=parse) still passes (PARSE-LEGACY). The two terminals are never conflated in the parse branch | `tests/unit/harvest-arxiv-recovery.test.ts` | EXEC | **NEW** |

## Registry — WO-3-B1 PR-B1A (attempt-scoped cache provenance gate)

> Deterministic, hermetic STATIC workflow-invariant locks for WO-3-B1 PR-B1A
> (Founder D-2026-0616-70 PART II). They read `.github/workflows/factory-harvest.yml`
> as TEXT (CRLF-normalized; NO workflow execution, NO network, NO YAML dep) and
> pin the run_attempt-scoped cache keys + the fail-closed pre-merge complete-set
> gate. ROOT CAUSE (run 27604921700): the 4 harvest-group caches used a RUN-SCOPED
> IMMUTABLE key (`github.run_id` only). On a rerun-failed-jobs attempt, attempt-2
> could not overwrite the partial attempt-1 cache; Merge restored the stale
> attempt-1 -> partial arxiv + missing HF papers/datasets -> HARVEST_HEALTH=red.
> Fix = attempt-scoped EXACT keys (run_id + run_attempt) on all 4 save AND the 4
> Merge current-run restore steps (NO restore-keys prefix), a 4/4-cache-hit gate
> that fail-louds (ATTEMPT_CACHE_SET_INCOMPLETE + exit 1) BEFORE R2 fallback /
> NDJSON bridge / merge / health publication, and a parallel skip_harvest
> source-attempt provenance path (requires source_run_attempt; exact key; 4/4
> gate; SOURCE_ATTEMPT_PROVENANCE_INCOMPLETE + exit 1). SCOPE: keys + gate only —
> entity floor / health threshold / adapters / job timeouts / R2 object hierarchy
> UNCHANGED (that is PR-B1B). Single file: `tests/unit/harvest-cache-provenance.test.ts`.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| B1A-SAVE-ATTEMPT (#1) | all 4 Solidify save keys carry BOTH `${{ github.run_id }}` AND `${{ github.run_attempt }}` | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-NEG-ATTEMPT (#11) | NEGATIVE: no current harvest-raw key uses the run-id-only (no run_attempt) form (line-level: stripping run_attempt from any of the 4 keys -> a bare key line appears -> FAIL; provably tied to run_attempt presence) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-SAVE-IFALWAYS (#2/#13) | all 4 Solidify save steps retain `if: always() && skip_harvest != 'true'` (H2c failed-class terminal sidecar still saved on a failed-loud harvest) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-RESTORE-IDENTICAL (#3) | the 4 Merge current-run restore keys are byte-identical to the 4 save keys (same attempt-scoped string appears >=2x per group) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-NEG-PREFIX (#4/#12) | NEGATIVE: no harvest-raw restore uses a `restore-keys:` prefix (exact-only; converting any current restore to a prefix restore -> regex match -> FAIL) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-ATTEMPT-ENCODED (#7/#8) | every harvest-raw key encodes run_attempt (current) or source_run_attempt (skip) — the property that makes rerun-failed-jobs unable to consume an attempt-1 cache while rerun-all (new run_id) gets a clean set | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-GATE-FAILCLOSED (#5/#6) | a 4/4 complete-set gate exists: references all 4 restore cache-hit outputs, each checked == 'true', any miss -> ATTEMPT_CACHE_SET_INCOMPLETE + exit 1; placed AFTER all 4 current restores | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-GATE-BEFORE-MERGE (#9) | the gate PRECEDES R2 Batch Recovery (Fallback) + the NDJSON bridge (List Batches) + Merge Batches — R2 fallback may not fill a missing current-attempt group (gate exit 1 short-circuits the job) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-SKIP-SOURCE-ATTEMPT (#10) | skip_harvest declares a `source_run_attempt` input, recovers via the EXACT source-attempt key (no prefix), hard-requires BOTH source_run_id + source_run_attempt (pre-check exit 1) and has a 4/4 source-attempt gate (SOURCE_ATTEMPT_PROVENANCE_INCOMPLETE + exit 1) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-SCOPE (#14) | SCOPE guard: merge floor `-lt 85000`, Harvest Health Summary, per-job timeouts (330/300/120), and the R2 fixed-key object hierarchy (`ingestion/raw/`, `state/harvest-health/latest.json`) are UNCHANGED; the test touches no floor/health/adapter module (no product logic re-implemented) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |

## Registry — MFH PR-A (master-fusion EXACT-PRODUCER R2 HANDOFF, S1-BR)

> Deterministic, hermetic invariants for the MASTER-FUSION-HANDOFF PR-A (Founder
> D-73). ROOT CAUSE: Factory 4/4 "Master Fusion (Persist R2)" fail-closed because
> the GHA cache carrying the fused output (output/cache/fused/) from "Master Fusion
> (Compute)" was unretrievable at Persist restore time (LRU eviction/consistency
> miss); the empty-state guard correctly refused to publish. FIX: a DURABLE,
> run + PRODUCER-attempt scoped, content-verified EXACT-PRODUCER R2 handoff
> (`state/_handoff/fused/<upstream>/<run>/attempt-<n>/` + a run-scoped `handoff.json`
> descriptor written LAST). Persist reads the descriptor, verifies provenance, uses
> the GHA cache only as an OPTIONAL fast path (no restore-keys), and recovers from
> the EXACT producer staging on miss/mismatch BEFORE the compatibility publish;
> VFS + Upload verify their restored fused set EQUALS Persist's VERIFIED identity
> and recover from the SAME exact staging, never from the fixed state/fused-entities/
> copy. EXEC tests drive the real verifier module (`fused-handoff-manifest.js`) on a
> temp dir (no R2). STATIC tests read `factory-upload.yml` as text (no execution).

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| MFH-MANIFEST | Manifest schema + counts: full field set; `.complete` counted as a file; per-file {relative_path,size_bytes,sha256}; set_sha256 over the STABLE-SORTED (path,sha256) tuples; manifest carries NO self-hash; verification enforces EXACT set equality (missing/extra => fail), per-file size + sha256, set hash, >=400 part + >=400 processedShards + `.complete` gates; NEVER count-only | `tests/unit/fused-handoff-manifest.test.ts` | EXEC | **NEW** |
| MFH-DESCRIPTOR | Run-scoped descriptor provenance: current upstream + current factory run; producer_attempt a positive int <= current run_attempt; exact_staging_prefix == derived run+attempt path (no list-latest / no prefix guess / no previous-run fallback); missing/malformed => fail-loud | `tests/unit/fused-handoff-manifest.test.ts` | EXEC | **NEW** |
| MFH-DAG | Workflow DAG: Compute produces staging (data -> manifest LAST -> descriptor LAST-of-all, set -e); Persist reads+verifies descriptor, GHA exact-key fast path (NO restore-keys), verify-or-recover from EXACT staging, fixed copy written ONLY after VERIFIED + exposes verified job outputs; VFS + Upload accept only set hash == Persist output + recover EXACT staging + never read fixed state/fused-entities/; cleanup deletes current staging on Final Upload success, retains on failure, bounded 7-day GC refuses current run / non-_handoff carriers; delete-prefix locked to state/_handoff/; SCOPE: master-fusion algorithm, .complete/>=400 gates, timeouts, production uploader UNCHANGED | `tests/unit/fused-handoff-workflow.test.ts` | CONFIG + SOURCE | **NEW** |

## Registry — TA2-GATE PR-G1 (preview-grade cold-load runtime gate)

> Deterministic, hermetic invariants for the TA2 PREVIEW-GRADE RUNTIME GATE
> (Founder D-2026-0619-77). TWO classes in one file
> `tests/unit/ta2-preview-runtime-gate.test.ts` (collected by the Tier-1
> `unit-test` job): (1) STATIC workflow-invariant locks reading
> `.github/workflows/ta2-preview-runtime-gate.yml` + the two `scripts/ci/ta2-*.mjs`
> as TEXT (CRLF-normalized; no workflow execution, no network, no YAML dep;
> negative-presence locks inspect EXECUTABLE source with comments stripped); and
> (2) HERMETIC smoke-runner EXEC tests that import the pure predicates from
> `scripts/ci/ta2-preview-smoke.mjs` and drive `probe` with a MOCKED `fetch` (no
> live network). ROOT CAUSE (TA2-INCIDENT-1, SEV-1): a telemetry import pulled into
> the Worker-ENTRY synchronous cold-load chain made every Worker/SSR route return
> empty-body HTTP 500 in prod, while astro-build/vitest/tsc/local-miniflare ALL
> FALSE-PASSED — only a REAL CF preview deploy + a COLD first request catches it.
> SCOPE: the gate workflow + its two harness scripts ONLY; it deploys an EPHEMERAL
> `*.pages.dev` PREVIEW (never production / never `--branch=main`), holds the CF
> preview token (`CF_PREVIEW_API_TOKEN`, GitHub Environment `ta2-preview`) ONLY in
> the deploy + cleanup jobs, and never references the production `CLOUDFLARE_API_TOKEN`.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| TA2G-TRIGGER | trigger is `pull_request` to main ONLY (NEVER `pull_request_target`); fork PRs (head repo != base repo) fail-closed as TRUSTED_BRANCH_REQUIRED and the required `preview-smoke` check exits 1 (if: always() — no skip wedge, no green N/A) | `tests/unit/ta2-preview-runtime-gate.test.ts` | CONFIG | **NEW** |
| TA2G-SECRET | deploy + cleanup reference `CF_PREVIEW_API_TOKEN` via Environment `ta2-preview`; build + smoke jobs hold NO CF secret; the production `CLOUDFLARE_API_TOKEN` is never referenced; token never echoed (NEGATIVE: exposing the token to build/smoke trips the lock) | `tests/unit/ta2-preview-runtime-gate.test.ts` | CONFIG | **NEW** |
| TA2G-JOBS | four trust-domain jobs: build (checkout EXACT control SHA, mirror infra-deploy build+restructure, SHA-256 dist manifest, immutable artifact) -> deploy (download artifact, NO install/build/candidate-exec, `pages deploy dist --branch=<preview>`, output exact id+url) -> smoke (preview URL only) -> cleanup | `tests/unit/ta2-preview-runtime-gate.test.ts` | CONFIG | **NEW** |
| TA2G-PREVIEW-NAME | deterministic preview branch `ta2-pr-<PR>-run-<RUN_ID>-attempt-<RUN_ATTEMPT>-<CONTROL>`; HARD-ASSERT not main / not prod branch / not empty / control in a fixed set; never `--branch=main`; URL must be `*.pages.dev` and any `free2aitools.com` result fails (NEGATIVE: a `--branch=main` mutation trips the no-main lock) | `tests/unit/ta2-preview-runtime-gate.test.ts` | CONFIG | **NEW** |
| TA2G-PIN-TEL-R2 | ALL third-party actions pinned by 40-hex commit SHA; telemetry stays OFF (no `TELEMETRY_ENABLED` in executable YAML); `[env.preview]` canary AE dataset retained in `wrangler.toml`; an added request-path R2 WRITE on the shared `R2_ASSETS` binding blocks the preview (PREVIEW_R2_ISOLATION_REQUIRED + exit 1) | `tests/unit/ta2-preview-runtime-gate.test.ts` | CONFIG | **NEW** |
| TA2G-CLEANUP | cleanup runs `if: always()`, deletes by EXACT deployment id with `--force` (aliased previews), VERIFIES absence, and a cleanup/verify failure is RED (`process.exit(1)`, never warning-only) (NEGATIVE: downgrading cleanup to a warning drops the exit-1 path) | `tests/unit/ta2-preview-runtime-gate.test.ts` | CONFIG + SOURCE | **NEW** |
| TA2G-QUAL | INDEPENDENT `qualification-verdict` passes ONLY when candidate=PASS AND broken=EXPECTED_RUNTIME_FAIL AND recovered=PASS AND current_base=PASS AND every cleanup=PASS; the four controls map to candidate / broken(`cd64c8b4`) / recovered(`b5107e4c`) / current(PR base); a build/deploy failure CANNOT masquerade as a positive-control success (the deploy-result gate precedes the broken->EXPECTED_RUNTIME_FAIL relabel); matrix `fail-fast: false` so the expected-fail control never reds the job | `tests/unit/ta2-preview-runtime-gate.test.ts` | CONFIG | **NEW** |
| TA2G-SMOKE | EXEC: exactly the six endpoints in order with `/api/v1/health` FIRST (cold, no warm-up); per-endpoint content-type sanity (json for api/openapi/mcp, text/* for llms) + minimum structure (health JSON / mcp JSON-RPC / openapi openapi+paths / search object); 5xx / empty-body / wrong-content-type / parse-fail / timeout all FAIL-CLOSED; production custom domain + non-`*.pages.dev` hosts rejected; a healthy record carries ONLY status/content-type/length/sha256/parse (NO raw body, header or secret archived) | `tests/unit/ta2-preview-runtime-gate.test.ts` | EXEC | **NEW** |
| TA2G-IDENTITY | **TA2-GATE-PROVENANCE-1 (D-2026-0620-78)**: every artifact self-binds its EXACT built-commit identity and the verdict fails closed on any identity defect. BUILD computes `resolved_commit_sha = git rev-parse HEAD` AFTER checkout (HARD-ASSERT 40-hex, build FAILS otherwise) + a deterministic `build_artifact_sha256` (sha256 of the sorted dist manifest), writes self-binding `build-identity.json` INTO the dist artifact; github.sha is NEVER the control build identity. Identity propagates BUILD→DEPLOY(reads build-identity.json, no recompute)→SMOKE(`resolved_commit_sha` READ from deploy-info.json, NOT github.sha — the core fix)→CLEANUP→VERDICT. The smoke runner fails closed if `resolved_commit_sha` is absent/abbreviated (EXEC `checkBuildIdentity`). `qualification-verdict` runs `ta2-preview-cleanup.mjs --verify-identity-chain` (EXEC `verifyIdentityChain`, temp-dir fixtures) which FAILS when any control's stage SHA is missing/non-40-hex, the build/deploy/smoke/cleanup SHAs are not ALL identical, `build_artifact_sha256` differs across stages, a control label does not map to its EXPECTED SHA (broken `cd64c8b4…` / recovered `b5107e4c…` / current PR-base / candidate = gate-guard candidate_sha), or a stage record is missing; matrix label alone never qualifies. NEGATIVE: re-introducing `CANDIDATE_SHA=github.sha` into the smoke job trips the lock | `tests/unit/ta2-preview-runtime-gate.test.ts` | CONFIG + EXEC | **NEW** |

> Live-tier complement (NOT a hermetic PR test — requires real preview deploys):
> the A/B/C QUALIFICATION run itself (deploying candidate / `cd64c8b4` / `b5107e4c`
> / current-base to ephemeral previews) is gated on the admin setting up
> `CF_PREVIEW_API_TOKEN` + the `ta2-preview` GitHub Environment and has NOT been
> executed yet. SRS-1 holds the hermetic logic guard (the workflow + smoke
> semantics); the live qualification holds the empirical positive-control proof.

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

## Registry — W3-O1 (fused-input parse-attrition OBSERVABILITY)

> Deterministic, hermetic invariants for W3-O1 (Founder D-88 / D-89 / D-90).
> The Factory 4/4 NXVF binary-shard reader silently dropped any entry that
> failed to decode/parse (~0.005%/cycle). W3-O1 makes those drops COUNTED,
> CLASSIFIED, FINGERPRINTED, and surfaced as a PURE SIDE-CHANNEL — the codec,
> the offset table, the payload bytes, the entity survivors (byte + order), and
> the >=90% floor are ALL UNCHANGED. Two test tiers:
> (1) Rust (`rust/nxvf-core/tests/parse_attrition.rs` + the `parse_report` unit
> tests in `rust/nxvf-core/src/parse_report.rs`) prove conservation
> (declared==parsed+dropped), the json-parse SUBSET classification, per-record
> fields, raw-byte SHA-256 fingerprint fidelity (distinct invalid-UTF-8 -> distinct
> fp), the no-payload null, and survivor byte+order equality vs the legacy reader.
> (2) Vitest EXEC (`tests/unit/fusion-parse-attrition.test.ts`, collected by the
> Tier-1 `unit-test` job) drives the REAL JS canary + capability classifier
> (`scripts/factory/lib/fusion-capability.js` + `fusion-parse-canary.js` +
> `fusion-parse-accounting.js`) over synthetic NAPI-camelCase summaries: the
> 3-state capability-aware canary, the iron anti-empty-set rule, the
> drop_detail_records_seen == dropped fail-closed enforcement, and the
> sentinel-leak guard (no raw payload/source/token in any record or log line).
> A built-`.node` binding verifier (`scripts/factory/verify-parse-accounting-binding.mjs`,
> exit 2 when the addon is absent; NOT wired into any workflow) proves the
> records cross the real NAPI boundary. SCOPE: AES/Zstd/gzip/offset-table/payload
> bytes/entity fields/`>=90%` floor UNCHANGED; observe-only.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| W3O1-CONSERVE | Reader produces a structured report; `declared_entity_count == parsed_entity_count + dropped_entity_count`; `parse_error_count` = the json-parse SUBSET only (offset-boundary/zstd/gzip are DISTINCT classes, not folded in); each dropped entry yields a structured record (part, entry_index, error_class, serde line/col, payload_length, fingerprint, fingerprint_status, attribution_status) | `rust/nxvf-core/tests/parse_attrition.rs` + `rust/nxvf-core/src/parse_report.rs` (unit) + `tests/unit/fusion-parse-attrition.test.ts` (aggregate) | EXEC | **NEW** |
| W3O1-FINGERPRINT | `payload_fingerprint` = SHA-256 over the RAW payload BYTES truncated to 16 hex (no UTF-8/lossy/JSON projection — two distinct invalid-UTF-8 byte sequences that collapse under lossy conversion STILL differ); no-payload (offset-boundary) -> fingerprint null + `fingerprint_status=unavailable_no_payload` (empty bytes NEVER hashed-as-identity); attribution_status ALWAYS "unavailable" (NXVF has no out-of-JSON identity envelope; no regex-scan of malformed bytes) | `rust/nxvf-core/tests/parse_attrition.rs` + `rust/nxvf-core/src/parse_report.rs` | EXEC | **NEW** |
| W3O1-SURVIVOR | The fused survivor set is byte-identical AND same-order vs the pre-feature reader; `read_binary_shard` is a thin survivor-only wrapper over the report variant (accounting is a pure side-channel that never alters the kept set) | `rust/nxvf-core/tests/parse_attrition.rs` | EXEC | **NEW** |
| W3O1-CAP | Capability handshake: the Rust/NAPI surface exports `PARSE_ACCOUNTING_PROTOCOL===1` + a self-declaring `parseAccounting.protocolVersion`; JS classifies engine_mode ('rust'\|'js') + protocol (1\|'legacy'\|'unavailable'); a default-zero/absent field is NEVER inferred as protocol 1 | `tests/unit/fusion-parse-attrition.test.ts` | EXEC | **NEW** |
| W3O1-CANARY | 3-state canary: PRESENT_VALID(+0->PASS / +drops->DEGRADED, never blocks); EXPECTED_BUT_MISSING (v1-capable but summary missing/old/non-conserved OR aggregate non-conservation OR drop-detail incomplete -> FAIL + the ONLY new blocking case); NOT_ACTIVE_OR_NOT_APPLICABLE (legacy/JS/no monitored shard/zero shards -> NOT_EVALUATED/WARN, never PASS, never blocks). IRON RULE: UNKNOWN never -> PASS; legacy/inactive never -> integrity FAIL. Anti-empty-set: no-summary/zero-records/zero-shards/addon-without-field/default-zero/empty-object never reported as dropped=0 PASS; every verdict carries a reason code + the full field set | `tests/unit/fusion-parse-attrition.test.ts` | EXEC | **NEW** |
| W3O1-SURFACED | Master Fusion emits one `NXVF_PARSE_DROP {json}` per drop record + an aggregate `NXVF_PARSE_ACCOUNTING` summary including `drop_detail_records_seen`; under a v1 run `drop_detail_records_seen == dropped_entity_count` is ENFORCED fail-closed (stranded records throw, BEFORE the sentinel); the fail-closed path does NOT touch the `>=90%` floor; records + logs carry ONLY irreversible coordinates (sentinel-leak guard: no raw payload/source/token) | `tests/unit/fusion-parse-attrition.test.ts` | EXEC | **NEW** |

> Built-`.node` binding complement (NOT a hermetic PR test — requires the native
> build): `scripts/factory/verify-parse-accounting-binding.mjs` asserts the
> protocol export returns 1 and a REAL `fuseShard` on a crafted one-offset-boundary
> NXVF shard returns `parseAccounting.protocolVersion===1` with a drop-records
> array whose length === the dropped count. It exits 2 (not fail) where the
> `.node` is absent so it is runnable anywhere; it is intentionally NOT wired into
> any workflow (GHA log lines + the existing sentinel aggregate are sufficient).

## How SRS-1 is wired as the blocking gate

The Tier-1 suite runs through the **existing required `unit-test` job** in
`.github/workflows/test-suite.yml`, which executes `npx vitest run` on every
`pull_request` to `main`. `vitest.config.ts` includes `**/*.{test,spec}.ts`, so
both `tests/unit/*` (reused) and the new `tests/srs1/*` files are collected
automatically — no separate runner. A red SRS-1 assertion fails `unit-test`,
which blocks the merge. SRS-2A (Tier-2) is a separate, non-blocking,
post-deploy workflow and is never a PR check.
