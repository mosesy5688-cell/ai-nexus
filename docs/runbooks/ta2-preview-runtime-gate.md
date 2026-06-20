# Runbook — TA2 Preview-Grade Cold-Load Runtime Gate (PR-G1)

Authority: Founder D-2026-0619-77. Grounded in TA2-INCIDENT-1 (SEV-1): a telemetry
import pulled into the Worker-ENTRY synchronous cold-load chain made every
Worker/SSR route return empty-body HTTP 500 in production, while astro-build,
vitest, tsc, the static gate, and even a LOCAL Miniflare cold-boot all
FALSE-PASSED. Only a REAL Cloudflare Pages PREVIEW deploy + a COLD first request
exposes the failure class. This gate is that check.

- Workflow: `.github/workflows/ta2-preview-runtime-gate.yml`
- Smoke runner: `scripts/ci/ta2-preview-smoke.mjs` (pure Node 24 fetch, no deps)
- Cleanup: `scripts/ci/ta2-preview-cleanup.mjs`
- Required check name (added to branch protection LATER, by an admin):
  **`TA2 Preview Runtime Gate / preview-smoke`**

## What the gate does (per same-repo branch PR to main)

1. `gate-guard` (no CF secret): decides trust domain. Fork PRs (head repo != base
   repo) fail closed (`TRUSTED_BRANCH_REQUIRED`). Scans the PR diff for an added
   request-path R2 WRITE on the shared production `R2_ASSETS` binding and BLOCKS
   the preview with `PREVIEW_R2_ISOLATION_REQUIRED` if found.
2. `build` (no CF secret): checks out the EXACT control SHA, runs the SAME
   `npm ci` + `npm run build` + dist→Pages restructure as `infra-deploy`, computes
   a SHA-256 manifest of `dist`, uploads `dist` as an immutable artifact.
3. `deploy` (Environment `ta2-preview`, holds `CF_PREVIEW_API_TOKEN`): downloads
   the dist artifact (NO install, NO build, NO candidate code execution), deploys
   an EPHEMERAL preview `pages deploy dist --branch=<ta2-pr-...-CONTROL>` (never
   `--branch=main`), hard-asserts the resulting host is `*.pages.dev`, and outputs
   the exact deployment ID + preview URL.
4. `preview-smoke` (no CF secret): runs the 6-endpoint COLD-START smoke against
   the preview URL ONLY. This job's check is the required gate.
5. `cleanup` (`if: always()`, Environment `ta2-preview`): deletes the preview by
   EXACT deployment ID (`--force` for aliased previews) and VERIFIES absence. A
   cleanup/verify failure makes the required check RED.
6. `qualification-verdict`: independent consumer of the per-control results.

The six smoke endpoints (exactly the set that 500'd in the incident):
`/api/v1/health`, `/api/v1/search?q=test`, POST `/api/mcp` (tools/list),
`/api/v1/datasets`, `/openapi.json`, `/llms.txt`. The FIRST `/api/v1/health`
request is issued IMMEDIATELY (no warm-up). Any 5xx / empty body / wrong
content-type / parse-fail / timeout = gate FAIL. The smoke records ONLY status,
content-type, body length, body SHA-256, parse result, the EXACT built-commit
identity (control / requested_ref / resolved_commit_sha / build_artifact_sha256),
deployment ID, and preview URL — never full bodies, Authorization headers, or
secrets.

## EXACT built-commit identity (TA2-GATE-PROVENANCE-1, D-2026-0620-78)

The gate binds every runtime result to the EXACT commit each matrix control
actually built — NOT the PR merge-context `github.sha`. After it checks out its
control ref, each BUILD leg computes `resolved_commit_sha = git rev-parse HEAD`
(HARD-ASSERTED `/^[0-9a-f]{40}$/`, build FAILS otherwise) plus a deterministic
`build_artifact_sha256` (sha256 of the sorted dist file-list + per-file-hash
manifest), and writes a self-binding `build-identity.json` INTO the dist
artifact. The same `{control, requested_ref, resolved_commit_sha,
build_artifact_sha256}` is propagated, never recomputed:

```
BUILD  -> build-identity.json  (inside ta2-dist-<control>)
DEPLOY -> deploy-info.json     (ta2-deploy-<control>: reads build-identity.json, adds deployment_id/preview_url)
SMOKE  -> smoke-<control>.json (ta2-smoke-<control>: resolved_commit_sha READ from deploy-info.json, NOT github.sha)
CLEANUP-> cleanup-<control>.json (ta2-cleanup-<control>)
VERDICT-> downloads all four; `ta2-preview-cleanup.mjs --verify-identity-chain`
```

`qualification-verdict` ANDs the original PASS expression with an EXACT
identity-chain check that FAILS CLOSED if, for any control: a
`resolved_commit_sha` is absent/not-40-hex; the build/deploy/smoke/cleanup SHAs
are not ALL identical; the `build_artifact_sha256` differs across stages; or the
control label does not map to its EXPECTED SHA (`broken`=`cd64c8b4…`,
`recovered`=`b5107e4c…`, `current`=PR base, `candidate`=the gate-guard
`candidate_sha`). The smoke runner itself ALSO fails closed before any probe when
`resolved_commit_sha` is missing/abbreviated. Matrix label alone never qualifies.

## A/B/C qualification (the gate's own acceptance test)

The matrix runs four controls ON THE PR before merge:

| Control | SHA | Expected smoke verdict |
|---------|-----|------------------------|
| candidate | PR integration SHA | PASS |
| broken | `cd64c8b4` | EXPECTED_RUNTIME_FAIL |
| recovered | `b5107e4c` | PASS |
| current | PR base SHA | PASS |

`broken` qualifies as `EXPECTED_RUNTIME_FAIL` ONLY when its build SUCCEEDS AND its
deploy SUCCEEDS AND the cold `/api/v1/health` smoke FAILS (5xx/empty/unparseable).
A build/deploy-CREATION failure does NOT count as catching the incident — the
deploy-result gate precedes the relabel, so a broken build can never masquerade as
a positive control. `qualification-verdict` passes ONLY when
`candidate=PASS AND broken=EXPECTED_RUNTIME_FAIL AND recovered=PASS AND
current_base=PASS AND every cleanup=PASS`.

> The real A/B/C preview deploys CANNOT run until the admin sets up
> `CF_PREVIEW_API_TOKEN` + the `ta2-preview` Environment (below). Until then the
> hermetic tests (`tests/unit/ta2-preview-runtime-gate.test.ts`) lock the gate's
> logic, but the empirical positive-control proof is pending.

## Admin setup (one-time, post-merge, separate transaction)

1. Create a Cloudflare token scoped LEAST-PRIVILEGE: `Account > Cloudflare Pages :
   Edit` + `Account : Read` only (no Workers Scripts, R2 admin, DNS, or Zone). It
   does NOT need to publish to the production branch; the workflow never passes
   `--branch=main`.
2. Add it as the GitHub secret `CF_PREVIEW_API_TOKEN` inside a NEW GitHub
   Environment named `ta2-preview` (Settings → Environments). Add required
   reviewers if you want a human approval before any preview deploy.
3. `CLOUDFLARE_ACCOUNT_ID` is reused (read-only account id, not the prod token).
4. Run the qualification once (re-run the workflow on a PR) and confirm
   `qualification-verdict` = PASS.
5. ONLY THEN add `TA2 Preview Runtime Gate / preview-smoke` to main's required
   status checks (branch protection / ruleset). NOTE: required-status-checks are
   currently DISABLED on main at the classic-protection API (404) — confirm the
   true enforcement surface first. This is NOT done by the gate PR.

## Cleanup procedure (manual, if a preview is ever orphaned)

Previews are named `ta2-pr-<PR>-run-<RUN_ID>-attempt-<RUN_ATTEMPT>-<CONTROL>`, so
orphans are identifiable. To remove one manually:

```
npx wrangler@4 pages deployment list --project-name=ai-nexus
npx wrangler@4 pages deployment delete <DEPLOYMENT_ID> --project-name=ai-nexus --force
```

Then re-list and confirm the id is absent. `scripts/ci/ta2-preview-cleanup.mjs`
performs exactly this (delete-by-id + verify-absence) and exits non-zero on any
failure so the required check goes RED rather than leaving orphans.

## Secret revocation procedure (if `CF_PREVIEW_API_TOKEN` is suspected exposed)

1. Rotate the token in the Cloudflare dashboard IMMEDIATELY.
2. Update the GitHub secret `CF_PREVIEW_API_TOKEN` value in the `ta2-preview`
   Environment.
3. Audit recent gate runs + the Pages deployment list for unexpected activity.
4. Delete any orphaned previews (above).

Because the gate uses a DEDICATED preview-only token (never the production
`CLOUDFLARE_API_TOKEN`), revocation is low blast radius and does not affect
production deploys.

## Rollback of the gate itself

The gate never touches production. If it becomes flaky/blocking-in-error: demote
it from the required-status-checks set (branch-protection edit) and/or revert the
workflow PR. Both are safe and instant.
