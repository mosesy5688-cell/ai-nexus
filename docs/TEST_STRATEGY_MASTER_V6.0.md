# 🧪 Free2AITools V6.x Master Test Strategy & Constitution

**Document ID**: TEST-STRAT-MASTER-V6.1.1
**Date**: 2025-12-18
**Status**: 🟢 **APPROVED / LIVING DOCUMENT**
**Objective**: Transform implicit architectural rules into an explicit, automated **Test Constitution**.
**Auditors**: Helios (Chief Architect) & Grok 4

---

## 1. Executive Summary: The Hard Truth

**Core Insight**: 
We *already* possess a complete testing coverage "system" embedded implicitly within our architecture (V5.2 Limits, V6.0 Classification Rules, V6.1 Sitemap Logic). What was missing wasn't tests, but the **formal declarations** of those tests as a system.

**The Shift**:
We are moving from **"Implicit Quality"** (hoping the architecture holds) to **"Explicit Verification"** (proving it holds via automation).

**Target Status (Grade A+)**:
- **Zero Cost**: GitHub Actions Public Runners only.
- **Platform-Grade Trust**: "Free2AITools is not just a project; it is infrastructure."
- **Deep Defense**: Testing strictly covers safety (Kill-Switches), Data Integrity (SQL Dry-Runs), and User Experience (Hydration).

---

## 2. 📜 V6.x System Test Baseline (The "Test Constitution")

This section defines **"What makes a V6.x Release Qualified"**. These are the non-negotiable Acceptance Criteria mapped to our Architecture.

### 2.1 Data Layer Integrity (Source of Truth)
| Rule Breakdown | Acceptance Criteria (Pass/Fail) | Tooling |
| :--- | :--- | :--- |
| **Source Purity** | `models.category_status` MUST ONLY be populated via `pipeline_tag` mapping. No heuristic guesses. | L1/L8 Logic Unit Test |
| **Pending State** | Models with `pipeline_tag == null` MUST stay `pending`. They MUST NOT appear in Category Listing pages. | E2E (Playwright) |
| **Archival Safety** | `archived=1` models MUST still return `200 OK` (accessible via direct link) but be hidden from lists. | E2E (Playwright) |
| **No Implicit Regression**| Existing `tags` or `name` fields MUST NOT be modified by the classification process. | L8 Integration Test |

### 2.2 Constitution Compliance (Policy-as-Code)
| Rule Breakdown | Acceptance Criteria (Pass/Fail) | Tooling |
| :--- | :--- | :--- |
| **Traceability** | Every categorization MUST be traceable to a specific `pipeline_tag` source (Art 6.1). | L8 Log Audit |
| **Inferential Ban** | L8 Workers MUST NOT perform semantic inference (LLM calls) during runtime (Art 1.4). | CES-Check / Code Review |
| **Sitemap Frequency** | Sitemaps MUST be updated daily. `lastmod` timestamp MUST reflect `first_indexed` or update time (Art 6.3). | XML Validator / Worker Logs |

### 2.3 Sitemap & Indexing (SEO Grade)
| Rule Breakdown | Acceptance Criteria (Pass/Fail) | Tooling |
| :--- | :--- | :--- |
| **Availability** | `sitemap-index.xml` MUST be accessible (200 OK) at root/alias. | Uptime Monitor / E2E |
| **Structure** | Sitemap Index MUST correctly reference all shards. Shards MUST NOT exceed 45,000 URLs. | Unit Test (Generator) |
| **Effectiveness** | Google Search Console state MUST be "Success". Indexed Pages ratio should target ≥ 90%. | Manual Audit / API |

### 2.4 URL Stability (Persistence)
| Rule Breakdown | Acceptance Criteria (Pass/Fail) | Tooling |
| :--- | :--- | :--- |
| **Immutability** | URLs MUST NEVER be `DELETE`d. Content must shift to `archived` or `301 Redirect`. | DB Trigger / Policy |
| **Canonicalization** | EVERY entity page MUST have a valid `<link rel="canonical">` tag. | E2E (Playwright) |
| **Health** | Internal Broken Links (4xx/5xx) MUST be < 1% (Target 0 Critical). | L3 Guardian (Weekly) |

### 2.5 Operational Automation
| Rule Breakdown | Acceptance Criteria (Pass/Fail) | Tooling |
| :--- | :--- | :--- |
| **Run Verification** | L8 Precompute MUST log "Sitemaps regenerated" daily. | Observability Logs |
| **Data Fidelity** | Migration row counts MUST match strict expectations (e.g., 41,334 -> 41,334). | Migration Script Output |

### 2.6 Advanced Safety & Interaction (Fortress Grade)
| Rule Breakdown | Acceptance Criteria (Pass/Fail) | Tooling |
| :--- | :--- | :--- |
| **Kill-Switch (Art 2.3)** | Triggering `SYSTEM_PAUSE` MUST halt L8 execution immediately (0 logic runtime). | Unit Test (Mock KV) |
| **Schema Safety** | Migration SQL files MUST pass a local SQLite dry-run before deployment. | CI (Wrangler Local) |
| **Interaction (Hydration)** | UI Elements (Search, Filter) MUST be interactive (Alpine.js intialized). | E2E (Playwright Wait) |

---

## 3. The Zero-Cost Toolchain Matrix (How We Verify)

| Level | Tool | Coverage Target | Frequency | Cost |
| :--- | :--- | :--- | :--- | :--- |
| **L1: Iron Gates** | **Bash / ESLint** | • Constitution (Line Counts, File Size)<br>• **SQL Schema Dry-Run** (New) | Every Push | $0 |
| **L2: Unit Logic** | **Vitest** | • Classifier Logic (`enricher.ts`)<br>• **Kill-Switch Logic** (New)<br>• SQL Builders | Every PR | $0 |
| **L3: E2E Smoke** | **Playwright** | • Critical Paths (Home → Detail)<br>• **Alpine.js Hydration Check** (New)<br>• Canonical Tag Presence | Every PR | $0 |
| **L4: Performance** | **Lighthouse CI** | • Core Web Vitals (LCP, CLS)<br>• SEO Technical Score | Nightly | $0 |
| **L5: Production** | **Health Worker** | • R2 File Existence<br>• Queue Backlogs<br>• Dead Link Scan (L3) | Every 4h | $0 |

---

## 4. Implementation Specifications

### 4.1 Unit Testing (Vitest) - *Enforcing Data Integrity & Safety*
**Target**: `workers/unified-workflow/src/utils/`

```typescript
// tests/unit/safety.test.ts
describe('Fortress Safety', () => {
  it('should ABORT consumption when SYSTEM_PAUSE is true', async () => {
    const mockEnv = { KV: { get: () => 'true' } }; // Kill-switch active
    const result = await consumer(batch, mockEnv);
    expect(result.processed).toBe(0); // ZERO execution
  });
});
```

### 4.2 E2E Testing (Playwright) - *Enforcing UI/SEO & Hydration*
**Target**: Static Production Build

```typescript
// tests/e2e/interaction.spec.ts
test('Search Component Hydrates and Functions', async ({ page }) => {
  await page.goto('/');
  // Wait for Alpine.js to initialize (checking x-data attribute or state change)
  await expect(page.locator('#search-input')).toBeVisible();
  await page.type('#search-input', 'DeepSeek');
  // Verify DOM update (Search results appear)
  await expect(page.locator('.model-card')).not.toHaveCount(0); 
});

test('Canonical Tag Exists', async ({ page }) => {
  await page.goto('/model/deepseek-r1');
  const canonical = await page.getAttribute('link[rel="canonical"]', 'href');
  expect(canonical).toContain('free2aitools.com/model/deepseek-r1');
});
```

### 4.3 Infrastructure Testing (CI) - *Enforcing Deploy Safety*
**Target**: GitHub Actions

```yaml
# .github/workflows/infra-check.yml
steps:
  - name: Validating SQL Migrations
    run: npx wrangler d1 migrations apply --local --dry-run
```

---

## 5. Execution Plan (Week 1 Sprint)

**Goal**: Establish the "Test Baseline" automated gates.

| Day | Focus Area | Action Item | Success Metric |
| :--- | :--- | :--- | :--- |
| **Day 1** | **Unit Foundation** | Install Vitest. Test `modelEnricher` & **KV Kill-Switch**. | Tests pass > 95% |
| **Day 2** | **CI Integration** | Add **SQL Dry-Run** step. Block PR if tests fail. | CI Gate Active |
| **Day 3** | **Compliance E2E** | Install Playwright. Write **Hydration** & "Pending Visibility" tests. | Automated User & SEO Logic Check |
| **Day 4** | **Performance** | Setup Lighthouse CI for nightly runs. | Baseline Performance Score Established |
| **Day 5** | **Handover** | Document `npm run test` workflows in CONTRIBUTING.md. | "Test Constitution" Fully Active |

---

**Ratification:**

This document serves as the **Supreme Verification Standard** for the Free2AITools platform. No code shall ideally merge without passing the checks defined herein.

**Helios** (Chief Architect)
**Date**: 2025-12-18
**Status**: 🟢 **EXECUTE WEEK 1 PLAN**
