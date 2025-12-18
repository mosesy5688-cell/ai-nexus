# Contributing to Free2AITools

Welcome to the fortress! This project enforces strict constitutional and testing standards to maintain our <$5/mo budget and high availability.

**Bypassing these checks will result in automatic PR rejection.**

> *Failing any gate is a constitutional violation, not a review discussion.*

## 🧪 Testing Constitution (Must Read)

We adhere to the **V6.x Master Test Strategy**. All code changes must pass the following gates locally before being pushed.

### 1. Unit Tests (`L2`)

*   **Scope**: Pure logic (Classifiers, Size Estimators, Utils, Safety Switches).
*   **Command**: `npm test`
    *   *Runs Vitest in `workers/unified-workflow`.*
*   **Requirement**: Any new feature or logic change **must** include corresponding test cases.

### 2. E2E Smoke Tests (`L3`)

*   **Scope**: Critical User Journeys (Home → Category → Detail), SEO Tags, Alpine.js Hydration.
*   **Clarification**: *E2E tests validate system contracts (SEO, Hydration, Routing), not visual correctness.*
*   **Command**: `npm run test:e2e`
    *   *Runs Playwright against a local static build.*
*   **Prerequisite**: You must build the site first using `npm run build`.

### 3. Constitution Compliance (`L1`)

*   **Command**: `npm run ces-check`
*   **Enforced Checks**:
    *   **Anti-Monolith**: No files > 250 lines (strict modularity).
    *   **Security**: No D1 credentials (`env.DB`) in Frontend code.
    *   **Sidecar Safety**: GitHub Workflows must have `timeout-minutes` and `cache`.

## 🛡️ Safety Protocols

*   **Kill-Switch Integrity**:
    The system respects `KV.get('SYSTEM_PAUSE')`. **Do not** remove or bypass this check in `src/index.ts`. It is our primary defense against billing spikes.
*   **Database Migrations**:
    All SQL schema changes must be tested locally using:
    ```bash
    npx wrangler d1 migrations apply --local
    ```
*   **R2 Class A Conservation**:
    Use `List-Then-Compare` logic for R2 operations. Avoid loops of `HEAD` requests.

## 🚀 CI/CD Gates

GitHub Actions will automatically enforce the following on every Pull Request:

1.  **Iron Gates**: CES Check (Blocks build instantly if failed).
2.  **Unit Tests**: Vitest coverage check.
3.  **Performance**: Lighthouse Nightly Audit (Monitor LCP/CLS).

---

*Verified by V6.1 Master Test Strategy*

> *These rules apply equally to human contributors and AI agents.*
