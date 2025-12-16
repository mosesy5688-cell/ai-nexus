# ⚔️ Operation Fortress (V5.1.2) Execution Plan

**Codename**: The Purge & The Shield
**Objective**: Operationalize Constitution V5.1.2 (Iron Locks) to achieve Million-Scale stability within 48 hours.
**Status**: 🟢 **APPROVED FOR IMMEDIATE EXECUTION**
**Deadline**: 48 Hours from Activation

-----

## 🛑 Executive Audit Summary

**Auditor**: Grok 4 (Advisory Architect)
**Verdict**: **INDUSTRIAL-GRADE FLAWLESS**
**Assessment**:

  * **The Purge**: Ruthless and correct. Deleting `api/search` and `sitemap.xml.js` is non-negotiable for survival.
  * **Pagination**: The "5-Page Cap" is the watershed moment for million-scale UX. It treats rankings as a "Signal Window", not a "Database Dump".
  * **Hot Index**: Top 20k + 50ms Timebox is the only physical solution for client-side search at scale.
  * **Stability**: The Kill-Switch is a production-grade control lever.

-----

## 📅 The 48-Hour March (Phase-by-Phase)

### Phase 1: The Purge (Compliance) – **Hour 0-12**

**Goal**: Remove "Treasonable" code and enforce cleanliness. **Stop the bleeding.**

**Tactical Order (Strict Sequence):**

1.  **Stop the Reads**: Remove all `env.DB` imports from `src/pages/*.astro` and `src/components`.
2.  **Kill the APIs**:
      * `rm src/pages/api/search.js` (Major CPU leak)
      * `rm src/pages/api/like/[id].js` (Linear write risk)
      * `rm src/pages/api/image/[...id].js` (If D1 dependent)
3.  **Kill SSR Sitemap**: `rm src/pages/sitemap.xml.js`. (Switch to R2 static XML later).
4.  **Enforce the Law**: Add CI Check immediately.

**CI/CD Action:**

```yaml
- name: Enforce Constitutional Law (Zero D1 in Frontend)
  run: |
    if grep -r "env.DB" src/pages/ src/api/; then
      echo "❌ VIOLATION: D1 accessed from Frontend!"
      exit 1
    fi
```

### Phase 2: Static Pagination (Ranking Refactor) – **Hour 12-24**

**Goal**: Prevent Category Page OOM. **Make rankings scrollable again.**

**L8 Worker Logic:**

  * **Chunking**: Split entities into groups of 1,000.
  * **Output**: `ranking_{category}_p{n}.json` (Gzipped).
  * **Meta**: Generate `ranking_{category}_meta.json` (contains `total`, `pages`, `last_updated`).
  * **Cap**: Stop generating after **p50.json** (Top 50,000).

**Frontend Logic:**

  * **Load**: Fetch `meta.json` + `p1.json` on init.
  * **Scroll**: Infinite Scroll fetches `p2` -> `p5`.
  * **Stop**: After Page 5, show button: *"View full list via Filters or Search"*.

### Phase 3: Tiered Search (Hot Index) – **Hour 24-36**

**Goal**: Prevent Mobile Search OOM. **Instant results, zero freeze.**

**L8 Worker Logic:**

  * **Selection**: Top 20,000 entities via `(fni * 0.7 + popularity * 0.3)`.
  * **Output**: `cache/index/index_hot.json` (Gzipped < 500KB).

**Frontend Logic:**

  * **Worker**: Create `SearchWorker.ts`.
  * **Timebox**: Implement `Promise.race([search(), timeout(50)])`.
  * **Fallback UI**: *"No exact matches in top 20k. Showing related popular models. Use category filters for full exploration."*

### Phase 4: Queue Hydration (Stability) – **Hour 36-48**

**Goal**: Prevent Cron Timeouts. **Industrial stability.**

**Architecture:**

  * **Producer (Cron)**: Scans D1 -> Pushes IDs to Queue (Batch 100-300).
      * *Check*: `KV.get('SYSTEM_HYDRATION_PAUSE')`. If '1', abort.
  * **Consumer (Worker)**:
      * Fetch Data -> Materialize -> Write R2.
      * *Retry*: Exponential backoff on R2 write failure.

-----

## 🛡️ Verification Protocol

**Automated (CI Script):**

```bash
# 1. Constitutional Check
grep -r "env.DB" src/pages/ && exit 1

# 2. Hot Index Physical Limit
ls -lh cache/index/index_hot.json.gz | awk '{if ($5 > 500000) exit 1}' # Max 500KB

# 3. Pagination Safety
find cache/rankings -name "p*.json.gz" -size +1500k && exit 1 # Max 1.5MB

# 4. Pagination Cap
ls cache/rankings/text-generation/p*.json.gz | wc -l | awk '{if ($1 > 50) exit 1}' # Max 50 Pages
```

**Manual Acceptance:**

1.  **Mobile Scroll Test**: Open "Text Generation" on mobile -> Scroll 5 pages -> No freeze.
2.  **Search OOM Test**: Search generic term "Llama" on low-end device -> Instant results (<100ms).
3.  **Kill-Switch Test**: Set `SYSTEM_HYDRATION_PAUSE=1` -> Verify Producer logs "Paused".

-----

## 📝 Final Sign-Off

**This plan is not only safe to execute — it is dangerous NOT to execute.**
Delaying this means inviting technical debt and eventual collapse under data weight.
Executing this means building a fortress that will stand for years.

**Approved By:**

`Helios` (Chief Architect)
`Grok 4` (Advisory Architect)

**Date**: 2025-12-16
**Command**: **BEGIN THE PURGE.** 🚀
