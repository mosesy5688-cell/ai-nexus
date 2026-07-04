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

## Registry — GR-02 (Tier-A LIVE security headers)

> Deterministic, hermetic invariants for GR-02 (Founder D-184 §B). The static
> `public/_headers` is NOT applied by the SSR Worker, so the live authority is the
> SSR middleware response path. The EXEC tier imports the REAL exported pure
> applier from `src/middleware.ts` (astro:middleware stubbed to the identity
> wrapper — no Worker runtime) and drives plain `Response`/`Headers` objects; the
> SOURCE tier parses the middleware top-level imports. Tier-B (full CSP, COOP/
> COEP/CORP, HSTS/preload) is FORBIDDEN here. Live-tier complement (NOT a hermetic
> PR test): the candidate-only GR-02 header matrix in
> `.github/workflows/ta2-preview-runtime-gate.yml`'s `preview-smoke` step.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| GR02-HUMAN | text/html (human) SSR responses carry the full Tier-A set: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` (THIS directive only — no script/style/connect/img/default), `Referrer-Policy: strict-origin-when-cross-origin`, the conservative `Permissions-Policy` deny-list (no clipboard-write / no fullscreen), exactly one `X-Content-Type-Options: nosniff`; no COOP/COEP/CORP/HSTS | `tests/srs1/security-headers.test.ts` | EXEC + SOURCE | **NEW** |
| GR02-MACHINE | machine/API responses (non-text/html: /api/*, openapi.json, llms.txt, assets) get `nosniff` + `X-Frame-Options` ONLY — never CSP/Referrer-Policy/Permissions-Policy/COOP/COEP/CORP — and preserve ACAO/ACAM/ACAH + Cache-Control + ETag + Content-Type unchanged | `tests/srs1/security-headers.test.ts` | EXEC | **NEW** |
| GR02-IDEMPOTENT | `X-Content-Type-Options` is set only when absent (has()-guard) so an edge-injected value is never doubled — exactly one effective value; the text/html discriminator never misclassifies /api or assets | `tests/srs1/security-headers.test.ts` | EXEC | **NEW** |
| GR02-IMMUTABLE | an immutable-header redirect Response does NOT throw on mutation (best-effort skip); status (301/410/404/200) + redirect Location preserved | `tests/srs1/security-headers.test.ts` | EXEC | **NEW** |
| GR02-NOIMPORT | `src/middleware.ts` adds NO new top-level import (header values inline; the #2218 cold-load class); NON-VACUITY: injecting a forbidden lib import into the middleware source FAILS the lock | `tests/srs1/security-headers.test.ts` | SOURCE | **NEW** |

## Registry — GR-04 (cache route error-contract)

> Deterministic, hermetic invariant for GR-04 (Founder D-184 §C / D-186 §F).
> `src/pages/cache/[...path].js` is a RETAIN_JUSTIFIED prod route (ranking
> infinite-scroll p2-p5 + monitoring consume `cache/` keys the CDN 403s;
> prefix-locked to the literal `cache/`, no SSRF). The ONE authorized hardening:
> the 500 catch path must NOT reflect the raw exception message (or stack /
> object key / R2 binding detail) to the client — it returns a DETERMINISTIC
> GENERIC 500 (`{error:"Internal Server Error"}`); the real error is logged
> server-side only. The EXEC tier drives the REAL exported `GET` with the
> `cloudflare:workers` env binding mocked (a controllable R2 stub — no network,
> no prod); the SOURCE tier reads the route + consumer source. ANTI-VACUITY:
> re-introducing `{ error: e.message }` on the 500 path turns the leak assertion
> RED. PRESERVED (unchanged, asserted): 200 streaming + HTTP metadata + ETag +
> `Cache-Control: public, max-age=60`; 400 missing-path; 404 missing-object;
> GET-only ownership; the literal `cache/` prefix (no traversal/escape); the
> `ranking-client.js` p2-p5 consumer.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| GR04-NOLEAK | A thrown R2 error yields a DETERMINISTIC GENERIC 500 (`{error:"Internal Server Error"}`, status 500); the raw exception message / stack / internal object-key / R2 binding name are ABSENT from the client body; server-side logging retained. NON-VACUITY: restoring `{ error: e.message }` reflection FAILS the leak assertion. PRESERVED & asserted: 200 streams body + metadata + ETag + `Cache-Control`, 404 stays 404, missing-path stays 400, the R2 key is the literal `cache/`+path (no traversal), GET-only, and `ranking-client.js`'s `/cache/rankings/...p${nextPage}.json` consumer is unchanged | `tests/unit/cache-route-error-contract.test.ts` | EXEC + SOURCE | **NEW** |

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
> **RECONCILED (D-2026-0703-236/237):** the run/attempt 4/4-GHA-hit CORRECTNESS gate
> (`ATTEMPT_CACHE_SET_INCOMPLETE`) is SUPERSEDED by the R2 source-authority resolver
> (GHA demoted to R2-verified acceleration). The attempt-scoped GHA key + skip_harvest
> provenance invariants above are PRESERVED (accel carrier); the replaced #5/#6/#9/#14
> rows re-point to the R2 gate — see **HARVEST-R2-AUTHORITY** below.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| B1A-SAVE-ATTEMPT (#1) | all 4 Solidify save keys carry BOTH `${{ github.run_id }}` AND `${{ github.run_attempt }}` | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-NEG-ATTEMPT (#11) | NEGATIVE: no current harvest-raw key uses the run-id-only (no run_attempt) form (line-level: stripping run_attempt from any of the 4 keys -> a bare key line appears -> FAIL; provably tied to run_attempt presence) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-SAVE-IFALWAYS (#2/#13) | all 4 Solidify save steps retain `if: always() && skip_harvest != 'true'` (H2c failed-class terminal sidecar still saved on a failed-loud harvest) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-RESTORE-IDENTICAL (#3) | the 4 Merge current-run restore keys are byte-identical to the 4 save keys (same attempt-scoped string appears >=2x per group) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-NEG-PREFIX (#4/#12) | NEGATIVE: no harvest-raw restore uses a `restore-keys:` prefix (exact-only; converting any current restore to a prefix restore -> regex match -> FAIL) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-ATTEMPT-ENCODED (#7/#8) | every harvest-raw key encodes run_attempt (current) or source_run_attempt (skip) — the property that makes rerun-failed-jobs unable to consume an attempt-1 cache while rerun-all (new run_id) gets a clean set | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-GHA-DEMOTED (#5/#6 RECONCILED) | **D-236/D-237 supersession**: the run/attempt 4/4-GHA-hit CORRECTNESS gate (`ATTEMPT_CACHE_SET_INCOMPLETE`, `cache_provenance_gate`) is REMOVED workflow-wide (executable AND comment — no restore cache-hit output is consumed by a fail-close gate). GHA is DEMOTED to R2-verified acceleration; the R2 authority resolver is the replacement (see HARVEST-R2-AUTHORITY). The revised block asserts the 12 D-237 §C R2-authority properties on EXECUTABLE source | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG + SOURCE | **RECONCILED** |
| B1A-R2-BEFORE-MERGE (#9 RECONCILED) | the R2 source-authority resolver (`harvest-handoff-consume`, fail-closed, no continue-on-error) PRECEDES the NDJSON bridge (List Batches) + Merge Batches; GHA restores are accel-only, never a correctness gate — publication cannot begin until four R2 authorities are verified | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **RECONCILED** |
| B1A-SKIP-SOURCE-ATTEMPT (#10) | skip_harvest declares a `source_run_attempt` input, recovers via the EXACT source-attempt key (no prefix), hard-requires BOTH source_run_id + source_run_attempt (pre-check exit 1) and has a 4/4 source-attempt gate (SOURCE_ATTEMPT_PROVENANCE_INCOMPLETE + exit 1) — PRESERVED (the R2 resolver additionally verifies the exact tuple) | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **NEW** |
| B1A-SCOPE (#14 RECONCILED) | merge floor `-lt 85000`, Harvest Health Summary, per-job timeouts (330/300/120), and the legacy `ingestion/raw/` + `state/harvest-health/latest.json` object keys are UNCHANGED; the attempt-scoped R2 source-authority hierarchy (`internal-handoff/harvest/...`) is the ADDITIVE change of D-236/D-237 | `tests/unit/harvest-cache-provenance.test.ts` | CONFIG | **RECONCILED** |

## Registry — HARVEST-R2-AUTHORITY (D-236/D-237)

> Deterministic, hermetic invariants for the Factory 1/4 HARVEST producer->Merge R2
> source-authority handoff repair (Founder D-2026-0703-236 + D-237). **Invariant:**
> the Factory 1/4 Merge path may consume Harvest producer data only after four
> immutable R2 source authorities from one exact run/attempt have been verified. A
> merge-only failed-jobs rerun may consume the highest prior COMPLETE attempt of the
> SAME run only when the current attempt has zero producer authorities. Any partial
> current attempt, mixed attempt, missing role or invalid authority fails closed
> before publication. ROOT CAUSE: the producer->Merge handoff was a purely ephemeral
> GHA cache carrier, so a GitHub "Re-run failed jobs" (reruns ONLY Merge as a new
> attempt, leaving the four successful producers at the prior attempt) could not
> recover the producers' data. FIX = a distinct, attempt-scoped, manifest-last R2
> handoff (`internal-handoff/harvest/<run>/<attempt>/<role>/`), a self-contained
> module `scripts/factory/harvest-authoritative-handoff.mjs` (C1 DUPLICATION — never
> imports the D-219 core or D-228 satellite carriers), 4 producer establishes + a
> Merge resolver with bounded prior-attempt recovery; GHA demoted to R2-verified
> acceleration. TWO tiers: (1) the STATIC workflow-invariant lock reads
> `.github/workflows/factory-harvest.yml` + the module source as TEXT; (2) the
> hermetic `node --test` contract suite `scripts/factory/harvest-authoritative-handoff.test.mjs`
> runs in the SAME required `unit-test` job via the C2-LOCK `node --test` list.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| HARVEST-ESTABLISH-FAILRED | each of the 4 producer jobs (huggingface/github/academic/ecosystem) establishes its OWN role authority via `harvest-handoff-establish --role=<role>` — FAIL-RED (no `continue-on-error`), gated `skip_harvest != 'true'`, step-level R2 creds + GITHUB_RUN_ID + GITHUB_RUN_ATTEMPT + PRODUCER_MAIN_SHA; EXACTLY 4 establishes workflow-wide, NONE in Merge | `tests/srs1/factory-harvest-handoff-invariant.test.ts` | CONFIG | **NEW** |
| HARVEST-MEMBERSHIP-FROZEN | the frozen `ROLE_MEMBERSHIP` owned-source set per role EQUALS both the workflow's actual `harvest-single.js <source>` invocations AND the module's declared contract (bidirectional drift guard); membership is EXPLICIT config, not dir-scan-derived. NON-VACUITY: adding/removing a source in either the workflow or the contract reds this lock | `tests/srs1/factory-harvest-handoff-invariant.test.ts` | SOURCE + CONFIG | **NEW** |
| HARVEST-R2-GATE | Merge runs the R2 resolver `harvest-handoff-consume` (fail-red) with both-mode identity env (GITHUB_* + PRODUCER_MAIN_SHA + SKIP_HARVEST + SOURCE_RUN_ID/ATTEMPT), PRECEDING the NDJSON bridge + Merge Batches; the old run/attempt 4/4-GHA correctness gate (`ATTEMPT_CACHE_SET_INCOMPLETE`) is ABSENT executable AND comment; attempt-scoped GHA keys survive as accel; the `internal-handoff` R2 prefix is never hardcoded in YAML | `tests/srs1/factory-harvest-handoff-invariant.test.ts` + `tests/unit/harvest-cache-provenance.test.ts` | CONFIG + SOURCE | **NEW** |
| HARVEST-ISOLATION | the D-219 core + D-228 satellite frozen `allowed_consumers` arrays are byte-present + DISJOINT from the harvest `['merge']` set (adding a harvest role to either reds their exact-array test); distinct `internal-handoff/harvest` R2 root (zero namespace collision with aggregate / aggregate-satellite); identity binds `github_run_id` with NO independent `cycle_id` authority | `tests/srs1/factory-harvest-handoff-invariant.test.ts` | SOURCE | **NEW** |
| HARVEST-CONTRACT | hermetic contract suite (node:test, injected fakes, no network/tar/@aws-sdk): manifest-LAST + producer read-back; deterministic tar + source-snapshot rescan; C6 fail-closed immutability collision; §4 membership acceptance + incidental `benchmark_NNN.json` exclusion + absence-as-record optional synthesis; bounded prior-attempt recovery (current-complete / current-empty->highest prior-complete same-run / current-partial fail-closed / none->MERGE_RED); skip_harvest EXACT tuple; GHA optional acceleration verified byte+sha against the selected R2 manifest; per-file post-extract re-verify; the D-236 §L + D-237 §K anti-vacuity mutations (each reverts a guard to red a required test) | `scripts/factory/harvest-authoritative-handoff.test.mjs` | EXEC | **NEW** |

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

## Registry — VFS-PACK-R2-AUTHORITY (D-2026-0704-245)

> Deterministic, hermetic invariants for the Factory 4/4 VFS Pack -> VFS Derived
> (PRIMARY) and VFS Derived -> Upload sitemap/RSS (SECONDARY) EXACT-PRODUCER R2 handoff
> repair (Founder D-2026-0704-245). ROOT CAUSE
> (VFS_PACK_TO_DERIVED_GHA_HANDOFF_1): a workflow_run GHA cache write-auth denial left
> the vfs-pack GHA cache unsaved, so VFS Derived's restore returned empty, the
> "Verify VFS Pack Files Present (defensive)" META>=1 guard fail-closed, and the whole
> publish chain was skipped — even though the 98 meta-NN.db were durably on R2 the entire
> run. FIX (Option A, the fused S1-BR sibling): vfs-pack-db establishes a DURABLE, run +
> PRODUCER-attempt scoped, content-verified authority
> (`state/_handoff/vfs-pack/<upstream>/<run>/attempt-<n>/` + a run-scoped `handoff.json`
> descriptor written LAST) and exports the verified identity; VFS Derived uses the GHA
> cache only as an OPTIONAL exact-key fast path (restore-keys prefix authority REMOVED)
> and recovers from the EXACT staging on miss/mismatch BEFORE the PRESERVED guard, then
> establishes its OWN sitemap/RSS authority (`state/_handoff/vfs-derived/...`, sitemap
> floor >=1, rss floor 0, bound to the vfs-pack parent set-sha); Final Upload verifies +
> recovers that current-cycle identity before publication. D-246: the RSS-generator
> INPUTS (`output/cache/{reports,knowledge}/index.json.zst`) are a CAPTURED_IF_PRESENT /
> floor-zero member class carried by the SAME vfs-pack authority — recorded per-input
> (present + sha256) in the manifest AND descriptor, staged under `rss-inputs/…` when
> present, and recovered FAIL-CLOSED before rss-generator (declared-absent = skipped +
> recorded, preserving the paused/static-historical RSS behavior) — so a present RSS
> input can never be silently lost to a cache-write denial (no longer "tolerated-empty").
> GHA demoted to verified
> acceleration; R2 is the correctness authority. TWO tiers: (1) the STATIC
> workflow-invariant lock reads `.github/workflows/factory-upload.yml` as TEXT; (2) the
> hermetic `node --test` contract suite `scripts/factory/vfs-derived-handoff-manifest.test.mjs`
> runs in the SAME required `unit-test` job via the C2-LOCK `node --test` list.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| VFS-PACK-MANIFEST | Manifest schema + verify (pure module, no R2): full §G field set (two carrier types, distinct prefix roots, no manifest self-hash); per-file {relative_path,size_bytes,sha256}; set_sha256 over STABLE-SORTED (path,sha256) tuples; EXACT set equality (missing/extra => fail) + per-file size+sha256 + meta_db_count + required-file-class floors (meta_db>=1; sitemap>=1; rss>=0), NEVER count-only; symlink/traversal members REJECTED | `scripts/factory/vfs-derived-handoff-manifest.test.mjs` | EXEC | **NEW** |
| VFS-PACK-DESCRIPTOR | Run-scoped descriptor provenance: current upstream-3/4 + current 4/4 run; producer_attempt a positive int <= current run_attempt; head-SHA + VFS_PACK_CODE_VERSION binding; secondary parent-set-sha binding; exact_staging_prefix == derived run+attempt path (no list-latest / prefix-guess / fixed / prior-run); missing field / carrier mismatch / bad sha => fail-loud | `scripts/factory/vfs-derived-handoff-manifest.test.mjs` | EXEC | **NEW** |
| VFS-PACK-RSS-INPUT | D-246 §C 6-state RSS-input durability (pure module): `probeRssInputs` records each RSS-generator input CAPTURED_IF_PRESENT (present+sha256) / FLOOR_ZERO (absent => present:false, not an error); `rssRecoveryPlan` emits ONLY declared-present inputs; `verifyRssInputs` is FAIL-CLOSED for a declared-present-but-missing (states 3/6/7) or sha-mismatched/stale-predecessor (states 4/8/9) input and SKIPs+records a declared-absent (states 1/5) — the per-input sha256 binds current-cycle content; rss inputs are NEVER folded into the meta set_sha256; symlink/traversal rss paths REJECTED; anti-vacuity: an honest present:true against an unrecovered payload reds verify | `scripts/factory/vfs-derived-handoff-manifest.test.mjs` | EXEC | **NEW** |
| VFS-PACK-DAG | Workflow DAG: vfs-pack-db produces attempt-scoped staging (meta data FIRST -> present RSS inputs -> manifest LAST -> descriptor LAST-of-all, set -e) + read-back verify + exports verified_vfs_pack_{staging_prefix,set_sha,producer_attempt}; VFS Derived consumes ONLY that identity, GHA exact-key fast path (restore-keys prefix authority REMOVED), verify-or-recover from EXACT staging BEFORE the PRESERVED META>=1 fail-closed guard, never a fixed state/vfs-data/ recovery input; D-246 recovers every declared-present RSS input from the EXACT staging + fail-closed verify BEFORE rss-generator (declared-absent skipped); manifest/descriptor NEVER written into the public output/data/ tree; SCOPE: pack-db.js / sitemap-gen / rss-generator, workflow permissions (single top-level actions:write), timeouts UNCHANGED | `tests/unit/vfs-pack-handoff-workflow.test.ts` | CONFIG + SOURCE | **NEW** |
| VFS-PACK-SECONDARY | Secondary sitemap/RSS seam: VFS Derived establishes a run+attempt-scoped `state/_handoff/vfs-derived/` authority (manifest LAST, descriptor LAST-of-all) bound to the vfs-pack parent set-sha (empty sitemap fails closed; empty rss tolerated per V27.39) + exports verified_vfs_derived_*; Final Upload verifies the restored sitemaps/RSS EQUAL that current-cycle identity + recovers the EXACT staging on miss/mismatch BEFORE `r2-upload-s3.js`; success-only cleanup deletes BOTH current-run staging prefixes + bounded 7-day GC refuses the current run / walks ONLY the two handoff roots; delete-prefix CLI-locked to state/_handoff/ | `tests/unit/vfs-pack-handoff-workflow.test.ts` + `scripts/factory/vfs-derived-handoff-manifest.test.mjs` | CONFIG + SOURCE + EXEC | **NEW** |

## Registry — SHARDS-R2-AUTHORITY (D-2026-0704-262, FIX-3 / C10 + GAP-5)

> Deterministic, hermetic invariants for the Factory 2/4 -> 3/4 SHARDS handoff
> authority repair + the intra-2/4 prepared-entity-data predecessor (Founder
> D-2026-0704-262). **Invariant:** Factory 3/4 Aggregate may consume the shard set
> only after the EXACT-20 shard identity of the CURRENT cycle has been verified
> against the attempt-scoped R2 authority established by Factory 2/4 save-shards-cache;
> a stale / foreign / prefix / branch-alias / mutable-latest / predecessor-cycle /
> count-only state may NOT suppress it, and a missing current-cycle authority or a
> residual mismatch fails CLOSED (no aggregate). ROOT CAUSE: the 2/4->3/4 shards
> handoff authority was a fixed-prefix per-file R2 copy (`state/shards/shard-<N>`) +
> a prefix GHA restore-key (`cycle-<process-id>-`) + count/magic-only guards, so a
> stale/foreign/predecessor-cycle set could be consumed unverified. FIX-3 (mirrors the
> D-245 vfs-derived pattern): save-shards-cache establishes a DURABLE, process-run +
> PRODUCER-attempt scoped, content-verified authority
> (`state/_handoff/shards/<process-run>/attempt-<n>/` + a run-scoped `handoff.json`
> descriptor written LAST) with a set_sha256 over the EXACT 20 shards (shard-0..19);
> merge-core-compute resolves ONLY that authority via the process-id descriptor, uses
> the GHA cache as an OPTIONAL exact-key fast path (restore-keys prefix authority
> REMOVED) verified against the manifest, recovers the 20 shards from the EXACT staging
> on miss/mismatch, and fails CLOSED (exit 1) on a missing authority / residual mismatch
> / non-20 set. The fixed prefix `state/shards/` is DEMOTED to a non-authoritative compat
> transport. GAP-5 applies the SAME shape to the intra-2/4 prepared-entity-data set
> (`state/_handoff/prepared-entity-data/<process-run>/attempt-<n>/`, multi-root data/+cache/,
> EXACT-set + data_manifest>=1 + merged_shard>=1 floors; the fixed prefix
> `state/prepared-entity-data/` DEMOTED to compat). Cross-workflow note: the shards seam
> spans two DIFFERENT workflow runs, so the single both-side-derivable cycle key is the
> Process (2/4) run id (github.run_id producer / process-id consumer); the harvest upstream
> id is recorded as provenance but NEVER in the path (it is not reliably shared across the
> two runs). GHA demoted to verified acceleration; R2 is the correctness authority. TWO
> tiers: (1) the STATIC workflow-invariant lock reads factory-process.yml (producer) +
> factory-aggregate.yml (consumer) as TEXT; (2) the hermetic `node --test` contract suite
> `scripts/factory/shards-handoff-manifest.test.mjs` runs in the SAME required `unit-test`
> job via the C2-LOCK `node --test` list. R2 I/O reuses the GENERIC r2-workflow-cli ops
> (no new subcommand).

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| SHARDS-MANIFEST | Manifest schema + verify (pure module, no R2): two carrier types (shards-authority / prepared-entity-data-authority) with DISTINCT prefix roots + no manifest self-hash; per-file {relative_path,size_bytes,sha256}; set_sha256 over STABLE-SORTED (path,sha256) tuples; EXACT set equality (missing/extra => fail) + per-file size+sha256; shards = EXACT-20 member identity (shard-0..19; a 19-set is below-floor + a 21-set is MEMBER_SET_NOT_EXACT, NEVER a >=20 floor) + member_count agreement; prepared-entity-data = multi-root data/(.json,.json.zst)+cache/(unfiltered) EXACT-set + data_manifest>=1 + merged_shard>=1 floors; NEVER count-only; symlink/traversal members REJECTED; the r2-handoff internal `_manifest.json` sidecar is excluded at any depth while a real `data/manifest.json` member is preserved | `scripts/factory/shards-handoff-manifest.test.mjs` | EXEC | **NEW** |
| SHARDS-DESCRIPTOR | Run-scoped descriptor provenance: current Process (2/4) run id; producer_attempt a positive int (same-run bound `<=` current run_attempt ONLY when the consumer supplies its own attempt -- prepared-entity-data / rerun-failed-jobs; OMITTED for the cross-workflow shards seam); head_sha a well-formed 40-hex git sha (equality enforced only when the consumer supplies an expected value); exact_staging_prefix == derived process-run+attempt path (no list-latest / prefix-guess / fixed `state/shards/` / mutable-latest / two-level / foreign cycle); missing field / carrier mismatch / bad set-or-manifest sha => fail-loud | `scripts/factory/shards-handoff-manifest.test.mjs` | EXEC | **NEW** |
| SHARDS-DAG | Workflow DAG: save-shards-cache produces attempt-scoped staging (20 shards FIRST -> manifest LAST -> descriptor LAST-of-all, set -e) + read-back verify; merge-core-compute consumes ONLY the process-id descriptor authority, GHA exact-key fast path (restore-keys prefix authority REMOVED) verified against the manifest, verify-or-recover the EXACT 20-shard set from the EXACT staging, never a fixed `state/shards/` recovery input, EXACTLY-20 final gate, fail-closed (exit 1) on missing authority / recovery-verify failure / residual mismatch (no warning-only mismatch path); the matrix stream to `state/shards/` is DEMOTED to a compat transport; GAP-5 prepare-data establishes + matrix-shards verify-or-recovers the prepared-entity-data authority symmetrically (fixed `state/prepared-entity-data/` DEMOTED to compat); SCOPE: split-registry / shard-processor / aggregator invoked-never-re-pathed, process-id resolution + finalize cycle-output NOT referenced, R2 via GENERIC r2-workflow-cli ops (no new subcommand), top-level `actions:write` + `contents:read` permissions UNCHANGED | `tests/unit/shards-handoff-workflow.test.ts` | CONFIG + SOURCE | **NEW** |

## Registry — META-DB-PUBLISH-BINDING (D-2026-0704-252, FIX-4 / GAP-4 / C11)

> Deterministic, hermetic STATIC workflow-invariant lock for the Factory 4/4 Final
> Upload meta-NN.db PUBLICATION binding (Founder D-2026-0704-252 §D/§E + supplements
> D-254 §C DAG-proof / D-255 §E Class-A budget). **Invariant:** the PUBLISHED
> `output/data/*.db` set (the SQLite backing every entity/search API) MUST equal the
> CURRENT-CYCLE VFS Pack R2 authority set-SHA (H17/PR#2265 producer) before "Upload to
> R2 via S3 API" — no stale/foreign-cycle DB can publish unless its set-SHA matches the
> current-cycle authority. ROOT CAUSE (GAP-4 asymmetry): sitemap/RSS reach Final Upload
> under a D-245 set-SHA verify-or-recover gate, but the meta-NN.db they DESCRIBE arrived
> via the fixed-prefix `state/vfs-data/` restore (META-count floor ONLY) OR a STAGE-B
> fresh re-pack — NEVER set-SHA verified — so a stale/foreign-cycle DB could publish
> beneath a verified sitemap (the site would describe entities the served DB does not
> hold). FIX-4 (a CODE-ONLY fail-closed CONSUMER guard of the H17 producer authority;
> H17 runtime acceptance PENDING but its producer authority exists in code) adds
> `vfs-pack-db` to `upload.needs` and, BEFORE publish (and BEFORE the dedup restore, so
> `output/data/` carries the same meta+rankings `.db` shape as the producer manifest),
> verifies `output/data/*.db` EQUALS `verified_vfs_pack_set_sha` via the SAME H17
> verifier of record (`vfs-derived-handoff-manifest.mjs verify … --ext=.db`, EXACT set +
> per-file sha); on GHA/fixed-prefix miss OR mismatch it wipes `output/data/` + recovers
> from the EXACT vfs-pack staging + re-verifies, and fails CLOSED (`exit 1`) if the
> current-cycle DB identity cannot be established. meta-NN.db + sitemap/RSS now publish
> under the SAME current-cycle identity and cannot diverge. The V23.1/L2 SQL canaries are
> PRESERVED as QUALITY checks (structural `verify-db`), NOT identity authority. DAG: the
> added need is acyclic (`vfs-pack-db -> vfs-derived -> upload` stays a DAG; the edge only
> exposes already-verified outputs to a downstream sink; no duplicate producer, no
> 1/4-2/4-3/4 change). Class-A: 0 new routine R2 PUT on the success path (a small manifest
> GET only); recovery GETs the EXISTING staging ONLY on miss/mismatch; NO delete, NO new
> authority backup, NO LIST-scan identity proof. NO new module (reuses the H17 verifier).

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| META-DB-PUBLISH-BINDING | Static workflow DAG: `upload.needs` includes `vfs-pack-db`; a FIX-4 gate consumes ONLY `needs.vfs-pack-db.outputs.verified_vfs_pack_{staging_prefix,set_sha}` (never a re-derived/list-latest/attempt-glob prefix) + EXACT-set verifies the to-be-published `output/data/*.db` against the producer manifest (`--carrier=vfs-pack-authority --ext=.db`) requiring published set-SHA == authority set-SHA; the gate runs AFTER the fixed-prefix `state/vfs-data/` restore + BEFORE the dedup restore + BEFORE `r2-upload-s3.js`, so any DB arrival path (fixed-prefix / fresh re-pack) is re-bound to set-SHA equality; a stale fixed-prefix mismatch is NOT published (wipe + recover from the EXACT vfs-pack staging, never re-trust `state/vfs-data/`) then RE-VERIFIED; missing authority identity / recovery-verify failure / residual mismatch all fail CLOSED (`exit 1`); meta-NN.db + sitemap/RSS both verify current-cycle identity before publish (cannot diverge); the V23.1 SQL Health Check stays a QUALITY canary (no set-SHA authority); SCOPE — 0 new R2 write/delete/list (LOW-Class-A), reuses the H17 verifier (no new module), producer/pack-db/sitemap-gen/rss-generator/master-fusion + top-level `actions:write` permissions UNCHANGED. Anti-vacuity: removing `vfs-pack-db` from `needs`, removing the set-SHA gate, or removing a fail-closed branch each reds a required test | `tests/unit/meta-db-publish-binding-workflow.test.ts` | CONFIG + SOURCE | **NEW** |

## Registry — REGISTRY-R2-FRESHNESS (D-2026-0704-250)

> Deterministic, hermetic STATIC workflow-invariant lock for the Factory 4/4
> `master-fusion-compute` GLOBAL-REGISTRY R2-freshness stop-gap (Founder
> D-2026-0704-250, GAP-1, P0). **Invariant:** the FRESH current-cycle R2
> `state/registry/` restore (which Factory 3/4 wrote for THIS exact upstream cycle)
> WINS; a stale or `restore-keys`-prefix-restored GitHub Actions cache must NEVER
> prevent/suppress it, and no stale/foreign-cycle registry may proceed into Master
> Fusion as the valid-id set + FNI-percentile authority. ROOT CAUSE
> (REGISTRY_R2_STALE_CACHE_SUPPRESSION_1): under the normal cron cascade 3/4 is a
> `workflow_run` whose exact `global-registry-<upstream>` cache SAVE is write-denied
> (GitHub 2026-06-26 read-only-cache policy), so the exact current-cycle key always
> misses; the bare `restore-keys: global-registry-` then pulled the newest SURVIVING
> registry from a prior/FOREIGN cycle and a `BIN_COUNT >= 100` gate SUPPRESSED the
> fresh current-cycle R2 restore — a silent stale/mixed-cycle publication. FIX
> (stop-gap, the `state/registry/` fixed prefix is the FRESH-vs-STALE comparison —
> NOT the separately-gated FIX-1 full attempt-scoped carrier): the GHA cache is
> demoted to EXACT-KEY verified acceleration only (trusted iff
> `steps.cache-global-registry.outputs.cache-hit == 'true'`, an exact current-cycle
> key hit); the bare `restore-keys` prefix authority is REMOVED; every non-exact case
> WIPES the possibly-prefix-restored cache and performs the MANDATORY fresh R2
> `state/registry/` restore, preserving the legit fallback chain (state/registry/ →
> monolith `state/global-registry.json.zst` → `r2-registry-restore.js` bootstrap) and
> failing CLOSED (exit 1) when neither an exact current-cycle GHA hit NOR a fresh R2
> restore reaches the ≥100 `.bin` shard floor. The STATIC lock reads
> `.github/workflows/factory-upload.yml` as TEXT (CRLF-normalized; no execution, no
> network, no YAML dep) and is auto-collected by the Tier-1 `unit-test` job (vitest
> globs `tests/unit/*.test.ts`). SCOPE: the registry-restore ordering + cache
> classification + fail-closed guard in `master-fusion-compute` ONLY — the Master
> Fusion algorithm, FNI formula, fused-cache exact-key seam, and workflow permissions
> are UNCHANGED.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| REG-R2-EXACTONLY | The `global-registry-` GHA cache is EXACT-KEY verified acceleration ONLY: the Restore step keeps the exact `global-registry-<upstream>` key + `id: cache-global-registry` but carries NO `restore-keys:` line; the Ensure step wires `CACHE_EXACT_HIT: steps.cache-global-registry.outputs.cache-hit` and trusts the cache ONLY under `[ "$CACHE_EXACT_HIT" = "true" ]`. NON-VACUITY: re-adding a `restore-keys: global-registry-` prefix anywhere in the job reds the lock | `tests/unit/registry-r2-suppression-stopgap.test.ts` | CONFIG | **NEW** |
| REG-R2-NOSUPPRESS | The old `BIN_COUNT >= 100 → skip R2` suppression is GONE/inverted: the single `-ge 100` shard-floor check is NESTED UNDER the exact-hit trust gate (gate index < floor index) and precedes the exact-hit `exit 0`, so no top-level shard count can suppress the mandatory R2 restore that follows the wipe. NON-VACUITY: reintroducing a top-level ungated `-ge 100 → exit` suppression reds the lock | `tests/unit/registry-r2-suppression-stopgap.test.ts` | CONFIG | **NEW** |
| REG-R2-FRESHWINS | Fresh current-cycle R2 WINS: on any non-exact (untrusted) cache the Ensure step WIPES `cache/registry` + `cache/global-registry.json.zst` (so a prefix-restored/foreign registry is never consumed as authority) BEFORE the MANDATORY `restore-dir state/registry/ cache/registry/`; the legit fallback chain (monolith → `r2-registry-restore.js` bootstrap) is preserved and last-resort. NON-VACUITY: removing the `state/registry/` restore call reds the lock | `tests/unit/registry-r2-suppression-stopgap.test.ts` | CONFIG | **NEW** |
| REG-R2-FAILCLOSED | Fail CLOSED: after all recovery paths a `-lt 100` shard floor → `::error::` + `exit 1` is the TERMINAL gate (after the R2 restore + bootstrap); the current-cycle registry is established BEFORE `Align Registry Cache for Fusion` copies it into `output/cache/registry` and `Execute Master Fusion` (`master-fusion.js`, `ARTIFACT_DIR: ./output/cache/registry`) consumes it; SCOPE guard: fused-cache exact-key + top-level `actions: write` permissions unchanged | `tests/unit/registry-r2-suppression-stopgap.test.ts` | CONFIG | **NEW** |

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
| W3O1-CANARY | 3-state canary with a CLOSED per-shard accounting (every processed shard lands in exactly one bucket under v1 — monitored-binary OR not-applicable[legacy-JSON/JS-fallback]). PRESENT_VALID requires EVERY processed shard monitored+conserved+complete (no not-applicable remainder): +0->PASS / +drops->DEGRADED, never blocks. EXPECTED_BUT_MISSING (v1-capable but a summary missing/old/non-conserved, OR aggregate non-conservation, OR drop-detail incomplete, OR an UNACCOUNTED processed shard [monitored+not-applicable != processed, or processed < expected — a silently-skipped shard]) -> FAIL + the ONLY new blocking case. NOT_ACTIVE_OR_NOT_APPLICABLE (legacy/JS/zero shards, ALL-not-applicable[every shard legacy-JSON/JS-fallback, zero monitored], OR a PARTIAL run [some monitored + a not-applicable remainder whose attrition is UNOBSERVED]) -> NOT_EVALUATED/WARN, never PASS, never blocks. IRON RULE: UNKNOWN never -> PASS; legacy/inactive never -> integrity FAIL; a not-monitored remainder never -> clean dropped=0 PASS (its attrition is invisible). Anti-empty-set: no-summary/zero-records/zero-shards/addon-without-field/default-zero/empty-object/parser-not-on-path[JS-fallback]/unaccounted-shard never reported as dropped=0 PASS; every verdict carries a reason code + the full field set (incl. `not_applicable_shards`) | `tests/unit/fusion-parse-attrition.test.ts` | EXEC | **NEW** |
| W3O1-SURFACED | Master Fusion emits one `NXVF_PARSE_DROP {json}` per drop record + an aggregate `NXVF_PARSE_ACCOUNTING` summary including `drop_detail_records_seen`; under a v1 run `drop_detail_records_seen == dropped_entity_count` is ENFORCED fail-closed (stranded records throw, BEFORE the sentinel); the fail-closed path does NOT touch the `>=90%` floor; records + logs carry ONLY irreversible coordinates (sentinel-leak guard: no raw payload/source/token) | `tests/unit/fusion-parse-attrition.test.ts` | EXEC | **NEW** |

> Built-`.node` binding complement (NOT a hermetic PR test — requires the native
> build): `scripts/factory/verify-parse-accounting-binding.mjs` asserts the
> protocol export returns 1 and a REAL `fuseShard` on a crafted one-offset-boundary
> NXVF shard returns `parseAccounting.protocolVersion===1` with a drop-records
> array whose length === the dropped count. It exits 2 (not fail) where the
> `.node` is absent so it is runnable anywhere; it is intentionally NOT wired into
> any workflow (GHA log lines + the existing sentinel aggregate are sufficient).

## Registry — FD-16 / C0-CH-001 (verdict-vocabulary contract-honesty lock)

> Deterministic, hermetic POSITIVE-VOCABULARY ABSENCE locks for FD-16 /
> C0-CH-001 (Founder D-99 G-1/G-2/G-3, Page Messaging Contract Sec 5 forbidden
> list). NORTH STAR: the discovery layer delivers an evidence chain, it does not
> emit a SELECTION VERDICT. These read repo SOURCE of `select.ts` /
> `rationale-builder.ts` / `mcp.ts` / `mcp-select.ts` (comment/doc blocks STRIPPED
> so prose that NAMES a banned token as banned — e.g. "no pseudo-confidence" — does
> not false-trip) + parse the static `mcp.json` + `openapi-schema.json`. They are
> the COMPLEMENT of NEG-MCP/NEG-RANK/NEG-DOCS: those assert the NOT-section is
> PRESENT; FD-16 asserts the forbidden POSITIVE verdict tokens (a `recommendations`
> response key, a `confidence` field/scalar, "best AI model", "ranked
> recommendations", an affirmative "selected"-as-verdict) never reappear on the
> select/MCP/OpenAPI machine contract — a regression the present-NOT-section guard
> alone would not catch (a surface can carry the NOT-section AND still leak a
> `recommendations` key or `confidence` scalar). The wire array is the neutral
> `entries`; the honest evidence (`fni_summary`, `caveats`, FNI factor breakdown)
> is RETAINED. NO module execution, no `cloudflare:workers` import, no live fetch.
> Non-vacuity proven: injecting a `confidence` Entry property reds T5.
> SCOPE: machine surfaces only — NO producer/ranking/FNI/Factory dependency.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| FD16-WIRE (T1) | `/api/v1/select` response uses `entries`, NEVER a `recommendations` key; emits NO `confidence` field/scalar; RETAINS `fni_summary`/`caveats`/`fni_factors`; endpoint path `/api/v1/select` + `operationId selectModel` unchanged | `tests/srs1/verdict-vocabulary.test.ts` | SOURCE + CONFIG | **NEW** |
| FD16-RATIONALE (T2) | `rationale-builder.ts` produces `{ fni_summary, caveats }` evidence facts and NO `confidence` producer/field anywhere in code | `tests/srs1/verdict-vocabulary.test.ts` | SOURCE | **NEW** |
| FD16-MCP (T3) | MCP `select_model` tool description (handler AND static `mcp.json`) carries NO "best AI model" / "ranked recommendations" / `confidence` / affirmative "selected"-verdict; any "recommend" is the NEGATIVE disclaimer; states the CALLER makes the final choice | `tests/srs1/verdict-vocabulary.test.ts` | SOURCE + CONFIG | **NEW** |
| FD16-PASSTHRU (T4) | `mcp-select.ts` relays the 200 select body verbatim — injects no `recommendations`/`confidence`/"best AI model" (only the transient-503 retry text is synthesized) | `tests/srs1/verdict-vocabulary.test.ts` | SOURCE | **NEW** |
| FD16-OAS (T5) | Served OpenAPI: `SelectResponse` uses `entries` + declares NO `recommendations`; `Entry` declares NO `confidence` + retains `fni_summary`/`caveats`/`fni_factors`; select path/Entry prose carry no "best AI model"/"ranked recommendations"/confidence + state caller-decides | `tests/srs1/verdict-vocabulary.test.ts` | CONFIG | **NEW** |
| FD16-NONEXP (T6) | Tool identifier remains EXACTLY `free2aitools_select_model` and the OpenAPI endpoint path remains EXACTLY `/api/v1/select` (no identifier/path drift under the honesty correction) | `tests/srs1/verdict-vocabulary.test.ts` | SOURCE + CONFIG | **NEW** |

> State note (audit trail): at the time FD-16 was registered the machine surfaces
> already CONFORMED on `origin/main` — the `recommendations` key + synthetic
> `confidence` scalar + "best/ranked recommendations/selected" verdict prose flagged
> in the original C0-CH-001 ticket had already been removed by the
> P3-CONTRACT-1 PR-A contract-alignment work (`5900b5c3d`) and the G-05/§A wording
> fixes (`3e5694dbb`, `560dfe4f0`); the live select wire shape is `entries` (not
> `recommendations`), with no `confidence` field. This invariant LOCKS that
> already-correct state so the forbidden verdict vocabulary cannot regress back in.

## Registry — P2-TELEMETRY-TA2-RL (adoption-telemetry route-local re-attempt, #2218-safe)

> Deterministic, hermetic invariants for the P2 Adoption Telemetry Phase-A
> ROUTE-LOCAL re-attempt (Founder gate D-2026-0624-103 — the #2218-safe redo of
> TA2). It instruments ONLY the two approved request paths (MCP `src/pages/api/
> mcp.ts`, datasets `src/pages/api/v1/datasets.ts`) from WITHIN the route handlers
> (NEVER from middleware), emitting a bounded low-cardinality event via the
> EXISTING substrate (`emit`) + the EXISTING AE binding. Telemetry is DEFAULT-OFF,
> fail-open, non-blocking; deploy stays OFF. The new helpers `route-telemetry.ts`
> (env extraction + closed-event build + emit forward) and `route-classify.ts`
> (pure pre-classifiers) carry NO raw Request/URL/Headers/body. These tests
> execute the REAL route handlers with internal handlers stubbed + an AE TEST
> DOUBLE (`mock-binding.ts`) — no network, no prod, no AE write — and walk the
> middleware static-import graph to prove the #2218 import edge is impossible.
> This is a TELEMETRY CODE CANDIDATE: DEFAULT-OFF, NOT active, NOT adoption-proven.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| TEL-RL-OFF | DEFAULT-OFF equivalence: with `TELEMETRY_ENABLED != 'true'`, both MCP (initialize/tools_call) and datasets (200/302/404) responses are byte/status equal to the no-locals baseline AND ZERO AE writes are attempted on the mock binding (gates 1, 11, 12) | `tests/srs1/telemetry-route-local.test.ts` | EXEC | **NEW** |
| TEL-RL-ON | ENABLED + bound => EXACTLY ONE bounded write per instrumented dispatch; index is the surface (`mcp.initialize`/`mcp.tools_call`/`datasets.302`); 8 closed-enum blobs, 0 doubles, 1 index; tool enum + status class (200->2xx/302->3xx/404->4xx) + UTC hour bucket present; cardinality bounded to known closed enum values (gates 2, 8) | `tests/srs1/telemetry-route-local.test.ts` | EXEC | **NEW** |
| TEL-RL-FAILOPEN | FAIL-OPEN: missing binding => no write/no throw; a SYNCHRONOUSLY throwing sink leaves status/body unchanged and only increments the submission-error counter; a hostile `locals.runtime` getter cannot throw into / alter the route; the MCP tool-error (500) path returns the SAME JSON-RPC error ON vs OFF (gates 3, 4, 5, 14) | `tests/srs1/telemetry-route-local.test.ts` | EXEC | **NEW** |
| TEL-RL-PRIVACY | The written payload carries NO raw url/query/body/header/token/path/host (only the closed referer-host CLASS); a smuggled forbidden dimension (e.g. `ip`) is rejected by the substrate schema before the sink (gates 6, 7) | `tests/srs1/telemetry-route-local.test.ts` | EXEC | **NEW** |
| TEL-RL-TRAFFIC | A known-crawler UA is classed `bot_crawler` (NOT `external_api`/real-user); an unknown external UA is `unknown` (EXTERNAL_OR_UNCLASSIFIED), never force-classified as a user (gate 13) | `tests/srs1/telemetry-route-local.test.ts` | EXEC | **NEW** |
| TEL-RL-NONVAC | NON-VACUITY: BOTH approved routes still import `route-telemetry` AND call `emitRoute(...)` (the test FAILS if route instrumentation is removed); NEITHER route names the AE binding token (no-read invariant preserved) (gate 15) | `tests/srs1/telemetry-route-local.test.ts` | SOURCE | **NEW** |
| TEL-RL-BUNDLE | IMPORT/BUNDLE SAFETY (#2218 prevention): `src/middleware.ts` has NO direct telemetry import edge AND no telemetry module is reachable from the transitive middleware static-import (Worker-startup) chain; NON-VACUITY mutation — injecting a `middleware -> telemetry` static import MAKES the graph walk FAIL, removing it restores PASS (repo stays clean); a resolver self-check proves the walker resolves a real edge (gates 9, 10, 16) | `tests/srs1/telemetry-bundle-boundary.test.ts` | STRUCT | **NEW** |

## Registry — B1 (D-180 data-mirror proxy prod-exposure removal, SECURITY)

> Deterministic, hermetic STRUCT route-removal invariant for B1 (Founder D-180).
> `src/pages/data-mirror/[...path].ts` was an Astro SSR catch-all ROUTE that, in
> the production `output:'server'` + Cloudflare deployment, was publicly reachable
> at `/data-mirror/<path>`; on GET it fetched
> `https://cdn.free2aitools.com/cache/${path}` and returned the JSON body with
> `Access-Control-Allow-Origin: *` — a GET-only proxy with NO size limit, NO
> timeout, NO header forwarding, and ZERO tracked callers (absent from
> API/MCP/SDK/OpenAPI/sitemap/middleware/redirects). CLASSIFICATION:
> PREFIX_CONFINED_PROXY_WITH_UNJUSTIFIED_PROD_EXPOSURE — the target host+prefix is
> a fixed literal so it is NOT an SSRF, but a "CORS bypass proxy for local
> development" had no production justification while being prod-exposed. The
> approved remediation DELETES the route file; with no route file under
> `src/pages/`, Astro cannot route the path, so a public request to
> `/data-mirror/*` returns HTTP 404 (structural). This guard reads repo
> SOURCE/CONFIG only (no live fetch, no behavior re-implementation): the route
> file is ABSENT, no replacement `data-mirror` route exists under `src/pages/`, no
> `astro.config.mjs` redirect / `src/middleware.ts` rewrite recreates the path, no
> tracked RUNTIME source (`src/**`, `scripts/**`) references it, the route scan is
> NON-VACUOUS (discovers real route files), a missing routing root FAILS
> fail-closed, and a synthetic reintroduction turns the detectors RED. The
> runtime-reference scan is scoped to `src/**` + `scripts/**` so historical
> governance/brain text and this test's own forbidden-string fixture never
> false-trip. Single file: `tests/unit/data-mirror-route-removed.test.ts`.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| B1 | `data-mirror` proxy route file ABSENT (=> public 404); no replacement route, no redirect/middleware re-creation, no `src/**`/`scripts/**` runtime reference; non-vacuous + fail-closed + anti-vacuity-proven | `tests/unit/data-mirror-route-removed.test.ts` | STRUCT | **NEW** |

## Registry — B2-MCP-SIZE-GUARD (MCP request/argument size guard)

> Deterministic, hermetic invariants for the B2 MCP request/argument size guard
> (Founder D-178 §D / D-182). ROOT CAUSE: the MCP JSON-RPC route
> (`src/pages/api/mcp.ts`) had NO application-layer size/shape guard — an oversized
> or pathological body was parsed in full (`request.json()`) and dispatched into
> search/VFS/R2/DB work before any limit was consulted. FIX: a new pure
> `src/lib/mcp-guard.ts` with two strictly-ordered gates wired at the POST entry —
> G1 PRE-PARSE BYTE GATE (`readBoundedBody`: Content-Length is only a fast-reject
> HINT; the authoritative bounded ReadableStream read counts RAW chunk byteLength,
> cancels the stream the moment the running total exceeds MAX_REQUEST_BYTES=65536,
> and decodes via TextDecoder ONLY after the byte ceiling passes — decoded JS char
> length is NEVER used as a size measure) and G2 POST-PARSE STRUCTURAL GATE
> (`validateRpcShape`: nesting depth<=8, query/task<=2048 chars, id + each ids
> element<=256 chars, ids<=25, constraints<=16 keys / <=1024 UTF-8 bytes /
> scalar-only). Unified JSON-RPC error code -32001, `data:{limit,max}`, NO input
> echo, id=null pre-parse / echoed id post-parse; malformed JSON within the byte
> limit stays -32700. EXEC tests drive the real guard module (no network); the
> B2-ORDER row drives the real POST route with every internal handler mocked,
> proving NO handler/DB call precedes a clean pass of both gates. SCOPE: the guard
> module + the route wiring + this test only; the 5-tool set + in-spec behavior are
> unchanged (mcp.ts stays <=250 lines, CES Art 5.1). Single file:
> `tests/unit/mcp-request-size-guard.test.ts`.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| B2-BYTE-GATE | RAW-byte ceiling authoritative on every transfer encoding: EXACTLY 65536 accepted / 65537 rejected; Content-Length is a fast-reject HINT only (declared-oversize rejects WITHOUT reading the body); absent / false-small / malformed / negative Content-Length falls through to the bounded stream which still rejects; the stream is cancelled the moment the running total exceeds the cap; UTF-8 multibyte split across chunk boundaries decodes correctly (raw byteLength counted, never decoded char length) | `tests/unit/mcp-request-size-guard.test.ts` | EXEC | **NEW** |
| B2-STRUCT-GATE | Post-parse structural caps each fire at boundary+1 with the correct `data.limit` token + numeric `max`: nesting depth (8 ok / 9 reject), query/task (2048), id + ids element (256), ids count (25 ok / 26 reject), ids non-string + over-long element, constraints keys (16) / UTF-8 bytes (1024, measured via TextEncoder not string.length) / scalar-only; a full valid scalar constraints object passes | `tests/unit/mcp-request-size-guard.test.ts` | EXEC | **NEW** |
| B2-ORDER | CORE SECURITY PROPERTY: a guard violation (byte OR structural) on a `tools/call` is returned BEFORE any of searchHandler / selectHandler / compareHandler / entityHandler is invoked (all four spies asserted zero calls) — proven on the REAL POST route; the byte gate precedes JSON.parse, the structural gate precedes method/tool dispatch | `tests/unit/mcp-request-size-guard.test.ts` | EXEC | **NEW** |
| B2-ERRSHAPE | Unified error contract: all guard violations -> code -32001 with `data:{limit,max}` and NO reflected attacker content; id=null for pre-parse (byte) rejects, echoed parsed id for post-parse (structural) rejects; malformed JSON within the byte limit stays -32700 (unchanged), not -32001 | `tests/unit/mcp-request-size-guard.test.ts` | EXEC | **NEW** |
| B2-REGRESSION | NO in-spec behavior change: initialize + tools/list are guard no-ops (serverInfo / 5-tool set unchanged); an in-spec search and a MAX-25-id compare DO reach their (mocked) handlers (guard is pass-through); results deterministic across 3 runs | `tests/unit/mcp-request-size-guard.test.ts` | EXEC | **NEW** |

## Registry — GR-01 (D-183 §D one-segment category soft-404 fix)

> Deterministic, hermetic invariants for GR-01 (Founder D-183 §D). ROOT CAUSE:
> `src/pages/[category].astro` is a one-segment catch-all that served ANY unknown
> slug as a 200 archive page — it FABRICATED category metadata
> (`CATEGORY_METADATA[c] || {label,icon,description}`), then read archive data
> (`fetchCatalogData`) and emitted an indexable canonical/meta for the bogus page
> (a SOFT-404; confirmed live: any unknown `/<slug>` returned 200, `s-maxage=30`).
> FIX: the resolved slug is validated against the AUTHORITATIVE category set — the
> KEYS of `CATEGORY_METADATA` (`src/utils/category-mapping.js`), the same map the
> page renders from (NO new hardcoded list). An unknown slug is a REAL 404:
> `Astro.response.status = 404` is set BEFORE `fetchCatalogData` (no archive/VFS
> read), the page is served `noindex` (Layout `noindex` prop + `X-Robots-Tag`),
> and the fabricated `|| {meta}` soft-200 default is removed. Reserved-route
> redirects + legacy alias 301s + adapter-compiled `redirects:` 301s
> (`/compare`→`/ranking` etc.) all still resolve BEFORE the catch-all (unchanged).
> SCOPE: the `[category]` catch-all + this test only — entity-detail 404/503, the
> shared `404.astro` page, sitemap, redirects, API, VFS, metadata are UNCHANGED.
> The test (a) EXECUTES the real `CATEGORY_METADATA` module to prove the validity
> predicate classifies every current category as 200-eligible and unknown slugs as
> 404, and (b) reads the page SOURCE to prove the page binds that predicate to a
> real 404 emitted before any data read, served noindex, with the fabricated
> default gone; anti-vacuity: deleting the status-404 line flips the detector RED.
> Single file: `tests/unit/category-soft404.test.ts`.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| GR-01 | Unknown one-segment `/<slug>` returns a REAL 404 (status 404, noindex, no fabricated archive canonical/meta) validated against the authoritative `CATEGORY_METADATA` keys, with the 404 set BEFORE `fetchCatalogData` (no archive/VFS read); every CURRENT valid category still 200-eligible; compiled redirects + entity-detail 404/503 unchanged; non-vacuous + anti-vacuity-proven (removing the status-404 reds the detector) | `tests/unit/category-soft404.test.ts` | EXEC + SOURCE | **NEW** |

## Registry — B3-OPENNESS-A1 (datasets commercial-residue honesty)

> Deterministic, hermetic invariants for the B3 OPENNESS-A1 datasets honesty fix
> (Founder D-187 §H). Free2AITools is all-free / open-access; the datasets surface
> carried COMMERCIAL RESIDUE advertising a non-existent "paid" tier. This is a
> COMPATIBILITY-SAFE correction: the legacy `tier:"free"` field is RETAINED in the
> response (deleting a field a consumer reads is breaking — deferred to v2), but
> the OpenAPI DatasetsResponse `tier` enum is capped to `["free"]` (no "paid"),
> marked `deprecated`, and points callers at the new truthful `access` field;
> `access:"public"` is added to every dataset item AND made a REQUIRED property of
> the item schema; the open-data page badge reads "Open Access". The OpenAPI
> assertions run against the SERVED `/openapi.json` PROJECTION (the
> `openapi.json.ts` route GET transform OUTPUT), not the static schema source
> (D-42 projection lesson); the response assertions invoke the REAL exported
> datasets GET handler. EXCLUDED (not touched): `SearchResponse.tier`, search
> defaults/limits, and the `FREE_TIER_MAX` constant (out of B3 scope). No live
> network. Single file: `tests/srs1/datasets-openness.test.ts`.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| B3-RES-NOPAID | SERVED `/openapi.json` DatasetsResponse item `tier.enum` is EXACTLY `["free"]` and never advertises "paid"; no paid/premium/subscription/enterprise/billing/upgrade wording anywhere in the served item schema. Non-vacuous: re-adding "paid" to the served enum reds the lock | `tests/srs1/datasets-openness.test.ts` | EXEC + CONFIG | **NEW** |
| B3-RES-DEPRECATED | SERVED DatasetsResponse `tier` is `deprecated: true` and its description names `access` as the replacement (deprecated legacy compatibility field). Non-vacuous: dropping the deprecated marker reds the lock | `tests/srs1/datasets-openness.test.ts` | EXEC + CONFIG | **NEW** |
| B3-RES-ACCESS-REQUIRED | SERVED DatasetsResponse item declares `access` (enum `["public"]`) AND `access` is a REQUIRED property of the item schema (`items.required` ⊇ {access}). Non-vacuous: removing `access` from `required[]` reds the lock | `tests/srs1/datasets-openness.test.ts` | EXEC + CONFIG | **NEW** |
| B3-EP-ACCESS | The REAL `/api/v1/datasets` GET handler emits `access:"public"` on EVERY listed dataset item. Non-vacuous: removing the field / changing the value reds the lock | `tests/srs1/datasets-openness.test.ts` | EXEC | **NEW** |
| B3-EP-TIER-FREE | The `/api/v1/datasets` response RETAINS the legacy `tier` field and its only value is `"free"` (compat-safe; not deleted, never "paid"). Non-vacuous: deleting the field or changing the value reds the lock | `tests/srs1/datasets-openness.test.ts` | EXEC | **NEW** |

## Registry — SDK-SURFACE (D-221 SDK public-surface sync)

> Deterministic, hermetic DOCUMENTATION locks for the SDK PUBLIC-SURFACE SYNC
> (Founder D-221). FACT SYNCED: `@free2aitools/sdk@0.1.0` is published +
> registry-verified on npm; the public surfaces (`/developers`, homepage
> integration nav, `llms.txt`) were stale ("No SDK, no dependencies", no SDK
> discovery). This is a NARROW, factual correction — an INITIAL PUBLIC RELEASE,
> NOT GA, NOT an adoption/positioning claim. The locks read repo SOURCE/CONFIG
> only (`src/pages/developers.astro`, `src/components/home/HomeTechnicalHeader.astro`,
> `src/pages/index.astro`, `src/data/llms-template.txt`) and cross-check the REAL
> published SDK source (`packages/sdk/src/index.ts` + `client.ts`) so the
> example-uses-real-exports lock is non-vacuous. NO live network, NO module
> execution, NO behavior assertion. The TypeScript example uses ONLY real exports
> (`Free2AIClient` + its REST `search()` returning a typed `SearchResponse` whose
> `results` is `SearchResult[]`); the MCP-only `rank()`/`explain()` are asserted
> absent from the SDK/REST example. The homepage entry is pinned OUTSIDE the frozen
> hero `<h1>` / mission paragraph / meta+OG description. A whole-surface forbidden-
> claim scan (GA / production-ready / production-proven / stable-API-guarantee /
> 1.0-compatibility / widely-adopted / used-by-Agents / recommended-default /
> replaces-REST/MCP / provenance-verified-by-npm + paid tokens) is anti-vacuity
> proven against a synthetic over-claim. SCOPE: documentation surfaces only — NO
> SDK source / API / MCP / package.json / runtime change (the true scope guarantee
> is the PR diff; these locks pin the served wording). Single file:
> `tests/unit/sdk-public-surface.test.ts` (auto-collected by the Tier-1 `unit-test`
> job — no separate runner).

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| SDK-SURFACE-DEV | /developers: the exact stale phrase `No SDK, no dependencies` is ABSENT (§I#1); the direct-fetch path stays honest ("no additional dependency"); `@free2aitools/sdk` + `npm install @free2aitools/sdk` present (§I#2/#3); version `0.1.0` framed as an INITIAL PUBLIC RELEASE adjacent to the version and NOT as GA (§I#4); the TypeScript example imports only the REAL `Free2AIClient` export and calls `client.search({q,limit})`/reads `res.results`, never the MCP-only `client.rank(`/`client.explain(` (§I#5, cross-checked against `packages/sdk/src`); the neutral chooser presents SDK + REST + MCP as equally-valid ("remain fully supported alternatives", "according to your integration environment") (§I#6); the documented REST endpoints + EXACTLY the 5 MCP tools are unchanged and no `/api/v1/sdk` endpoint was invented (§I#10) | `tests/unit/sdk-public-surface.test.ts` | SOURCE | **NEW** |
| SDK-SURFACE-HOME | Homepage: the integration nav (`HomeTechnicalHeader.astro`) carries ONE SDK entry (link `/developers#sdk`, "TypeScript SDK", `@free2aitools/sdk` in the pill title); the frozen hero `<h1>` ("The Open-Source AI Registry") and the mission/value paragraph ("Scored by the Free2AITools Nexus Index (FNI)") are unchanged and carry NO SDK copy; the frozen homepage meta/OG description in `index.astro` is byte-unchanged and mentions no SDK (§I#7) | `tests/unit/sdk-public-surface.test.ts` | SOURCE | **NEW** |
| SDK-SURFACE-LLMS | `llms.txt` template carries the machine-readable SDK discovery: package `@free2aitools/sdk`, `npm install @free2aitools/sdk`, version `0.1.0`, purpose = typed client for the existing public API (NOT a new API surface), a `/developers` docs pointer, and REST + MCP retained as supported alternatives (§I#8) | `tests/unit/sdk-public-surface.test.ts` | CONFIG | **NEW** |
| SDK-SURFACE-NOCLAIM | NO forbidden over-claim on any edited public surface (developers.astro / HomeTechnicalHeader.astro / llms-template.txt): GA/General-Availability, production-ready/-proven, stable-API-guarantee, 1.0-compatibility, widely-adopted, used-by-Agents, recommended-default, replaces-REST/MCP, provenance-verified-by-npm, and paid tokens (subscription/billing/refund/paid-tier/credit-card/money-back/payment-processor) are ALL absent (§I#9). Anti-vacuity: a synthetic over-claim string trips the matcher | `tests/unit/sdk-public-surface.test.ts` | SOURCE + CONFIG | **NEW** |

## Registry — SAT-HANDOFF (D-228/D-230 satellite-registry R2 handoff DAG)

> Deterministic, hermetic invariants for the SATELLITE-REGISTRY R2 handoff repair
> (Founder D-2026-0702-228, D-230 scope correction). ROOT CAUSE
> (SATELLITE_REGISTRY_HANDOFF_CONTINUITY_INCIDENT, P0/SEV_2, fail-safe held): the
> warning-only GHA "Save Satellite Cache" was cache-service write-auth DENIED,
> leaving Persist green with no carrier while the four satellites had no R2
> fallback for the registry INPUT. FIX = a distinct, attempt-scoped, manifest-last
> R2 satellite-registry handoff over `cache/registry/` (namespace
> aggregate-satellite/...), a dedicated self-contained module
> `scripts/factory/satellite-registry-handoff.mjs` (C1 DUPLICATION — never imports
> the D-219 core `aggregate-handoff.mjs`), one verify-only preflight gate, and four
> independently-verifying consumers. GHA satellite carrier REMOVED from the
> correctness path (Option 1). TWO tiers: (1) the STATIC workflow-invariant lock
> below reads `.github/workflows/factory-aggregate.yml` as TEXT (CRLF-normalized;
> no execution/network/YAML dep) + the core module source; (2) the hermetic
> `node --test` contract suite `scripts/factory/satellite-registry-handoff.test.mjs`
> (12 D-230 transport-contract tests + C5 full-verify + C6 immutability collision +
> D-219 non-contamination isolation proof) runs in the SAME required `unit-test`
> job via the C2-LOCK `node --test aggregate-handoff.test.mjs
> satellite-registry-handoff.test.mjs` step (exact list; the core test also runs
> UNCHANGED, so adding a satellite role to the core closed set reds it).

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| SAT-DAG | `satellite-authority-preflight` EXISTS and `needs: merge-core-persist`; each of the four `aggregate-*` jobs `needs: satellite-authority-preflight` and NOT `merge-core-persist`; `finalize` still needs all four satellites + check-upstream (edge set unchanged); ONLY the preflight job depends on merge-core-persist | `tests/srs1/factory-aggregate-satellite-invariant.test.ts` | CONFIG | **NEW** |
| SAT-ESTABLISH-FAILRED | Persist runs `satellite-registry-establish` (`if: success()`, NO `continue-on-error`) with step-level R2 creds + CYCLE_ID + PRODUCER_MAIN_SHA; the preflight step is likewise fail-red; each satellite runs its exact `satellite-registry-consume --role=<search-index\|rankings\|knowledge-mesh\|trending>` binding the SAME attempt identity. NON-VACUITY: downgrading establish to warning-only / dropping a satellite's preflight edge reds SAT-DAG/this lock | `tests/srs1/factory-aggregate-satellite-invariant.test.ts` | CONFIG | **NEW** |
| SAT-GHA-REMOVED | GHA satellite carrier OFF the correctness path (Option 1): no consumer job restores `intra-cycle-<run>-satellite` or `global-registry-<run>`; no consumer/preflight job uses a `restore-keys:` prefix (no latest/prefix fallback); the removed Restore/Save Satellite Cache steps + Trending's global-registry guards (incl. the forbidden "Re-run failed jobs" phrase) are gone; the legacy intra-cycle satellite GHA carrier is absent from executable Factory workflow cache steps. WF-2 evaluates executable cache-key semantics after removing comments, and SAT-GHA-REMOVED fails if the legacy satellite save or restore carrier is reintroduced | `tests/srs1/factory-aggregate-satellite-invariant.test.ts` | CONFIG | **NEW** |
| SAT-CORE-UNTOUCHED | D-211/D-219 CORE handoff byte-unchanged: exactly ONE `handoff-establish`, the two `handoff-consume --role=merge-core-persist`/`--role=finalize`, all three core handoff step names present; the R2 prefix is never hardcoded in YAML (no `internal-handoff`); the core `aggregate-handoff.mjs` frozen `ALLOWED_CONSUMERS = Object.freeze(['merge-core-persist','finalize'])` array carries NONE of the four satellite roles (contamination guard — adding one reds both this lock and the core exact-array test) | `tests/srs1/factory-aggregate-satellite-invariant.test.ts` + `scripts/factory/satellite-registry-handoff.test.mjs` | SOURCE + CONFIG | **NEW** |
| SAT-CONTRACT | Hermetic contract suite (node:test, injected fakes, no network/tar/@aws-sdk): the 12 D-230 transport-contract tests (source snapshot == archive == manifest inventory == extracted set; missing/extra/renamed member, mid-gap, duplicate index, unexpected filename, source-changed-during-establishment, below-floor, empty all REJECTED), C5 fatal remote read-after-write verify, C6 fail-closed immutability collision (no exact-tuple overwrite), and the D-219 non-contamination isolation proof | `scripts/factory/satellite-registry-handoff.test.mjs` | EXEC | **NEW** |

## Registry — ALT-LINKER-FALLBACK-PARITY (D-253/D-254/D-255 JS-fallback ⇄ Rust parity)

> Deterministic, hermetic invariants for the alt-relation JS-fallback parity fix
> (Founder D-2026-0704-253 + D-254/D-255). ROOT CAUSE (the ingestion-cap
> selection-cohort defect — the specific parity gap IN SCOPE, NOT the only
> JS-vs-Rust-fallback divergence; see the OUT-OF-SCOPE list below):
> `scripts/factory/lib/alt-linker.js` `computeAltRelations` JS fallback carried a
> hard `const MAX_PER_CATEGORY = 5000` ingestion gate
> (`if (byCategory[category].length < 5000) push`), while the Rust path
> (`rust/satellite-tasks/src/alt_linker.rs compute_alt_relations_from_dir`) has NO
> ingestion cap — it accumulates the FULL per-category population as slim tuples
> (id, fni_score, tags) THEN sorts by fni_score and truncates to the top
> `MAX_PER_CATEGORY = 500`. So whenever the satellite-tasks crate is ABSENT (or the
> FFI throws → `computeAltRelationsFromDirFFI` returns null) the JS fallback SILENTLY
> DROPPED every entity streamed after the 5000th BEFORE the top-500-by-fni selection,
> so a late-streamed high-fni entity was excluded from the cohort Rust would select —
> a selection-cohort truncation, not parity. FIX = **option A (full-population
> ingestion)**: remove the JS ingestion cap so the fallback considers the full
> population before the SAME top-500-by-fni guard Rust uses (in `computeCategoryAlts`,
> `maxEntities = 500`), keeping only the slim fields Rust keeps
> (id/slug/fni_score/tags/type) so memory stays bounded like Rust's slim tuples.
> SCOPE OF PARITY (honest-contract): this achieves **SELECTION-COHORT parity** — the
> JS fallback now considers the full population before the shared top-500-by-fni
> selection, matching Rust. It is **NOT full output/byte parity**. The following
> PRE-EXISTING JS-vs-Rust-fallback divergences are OUT OF THIS FIX'S SCOPE (D-253 §G)
> and are flagged for Founder triage: (a) **self-relation emission when shard ids are
> non-canonical** — JS compares the raw tag-index id against `normalizeId(sourceId)`,
> so a source can be emitted as its own alt (Rust excludes self by index);
> (b) **per-category file envelope shape** — JS wraps
> `{_v,_ts,_cat,_count,relations:[...]}` vs Rust's bare JSON array; (c) **output id
> representation** — JS `normalizeId` vs Rust raw; (d) **meta schema/version**;
> (e) **`totalRelations` count semantics** — JS counts source-nodes vs Rust edges
> (data shape-identical). These stay latent because the JS fallback is
> TEST_PROVEN_ARMED (Rust is the prod primary). Rust crate + relation semantics
> UNCHANGED; ZERO R2 / cache / workflow / Factory-execution mutation (D-255 §J).
> Exposure: normal Factory uses the Rust path; the JS fallback is TEST_PROVEN_ARMED.

| ID | Protected behavior | Assertion file | Evidence | Status |
|----|--------------------|----------------|----------|--------|
| ALT-PARITY-DISPATCH | The REAL exported `computeAltRelations` dispatch is exercised via the mocked Rust-FFI seam: (a) Rust-AVAILABLE ⇒ Rust result propagated, the JS `shardReader` fallback is NOT invoked; (b) Rust-UNAVAILABLE (FFI returns null) WITH `shardDir` set ⇒ the JS fallback IS selected (shardReader streamed) and emits a non-empty set | `tests/unit/alt-linker-fallback-parity.test.ts` | EXEC | **NEW** |
| ALT-PARITY-NOTRUNC | A >5000-entity category whose TRUE top-500-by-fni cohort is streamed AFTER the 5000th (first-5000 = low-fni; excluded from the shared top-500-by-fni slice that the high-fni beyond-5000 cohort fills) is NOT silently truncated: the fixed fallback emits relations sourced ONLY from the high-fni beyond-5000 cohort (every `source_id` ∈ `hicohort`, none ∈ `locohort`). NON-VACUITY (empirically verified): restoring the old `MAX_PER_CATEGORY = 5000` ingestion cap does NOT drop the count to 0 — the low-fni first-5000 cohort still emits ~500 relations (self-edges via the pre-existing non-canonical-id self-relation quirk, divergence (a) above). The discriminator that reds this test is the `source_id`-must-come-from-`hicohort` assertion (restored cap ⇒ `source_id` ∈ `locohort` ⇒ red), NOT a drop to zero | `tests/unit/alt-linker-fallback-parity.test.ts` | EXEC | **NEW** |
| ALT-PARITY-PERF | Perf guard (D-254 §H): a 12000-entity single-category fallback completes with bounded (slim-tuple, Rust-equivalent) memory — no obvious local OOM / unbounded structure — so option A (cap removal) is memory-safe rather than requiring fail-loud | `tests/unit/alt-linker-fallback-parity.test.ts` | EXEC | **NEW** |
| ALT-PARITY-SRCLOCK | `alt-linker.js` no longer contains the `const MAX_PER_CATEGORY =` declaration or the `length < MAX_PER_CATEGORY`/`length < <n>) byCategory[...].push` truncation gate; the full-population slim-projection push IS present. Reintroducing the silent-truncation cap reds this SOURCE lock | `tests/unit/alt-linker-fallback-parity.test.ts` | SOURCE | **NEW** |

## How SRS-1 is wired as the blocking gate

The Tier-1 suite runs through the **existing required `unit-test` job** in
`.github/workflows/test-suite.yml`, which executes `npx vitest run` on every
`pull_request` to `main`. `vitest.config.ts` includes `**/*.{test,spec}.ts`, so
both `tests/unit/*` (reused) and the new `tests/srs1/*` files are collected
automatically — no separate runner. A red SRS-1 assertion fails `unit-test`,
which blocks the merge. SRS-2A (Tier-2) is a separate, non-blocking,
post-deploy workflow and is never a PR check.
