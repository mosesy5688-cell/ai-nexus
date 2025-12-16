
# 📜 Free2AITools Constitution V5.1.3 (The Sidecar Protocol)

**Codename**: The Five-Dollar Sovereign (Sidecar Edition)
**Theme**: Hybrid Cloud Fortress (混合云堡垒)
**Objective**: 1,000,000 Entities, Zero Overage, Heavy Artillery Support
**Effective Date**: 2025-12-16
**Status**: 🟢 **RATIFIED & ACTIVE**

-----

## 🚫 Article 0: Non-Negotiable Mandates (零容忍指令)

**Art. 0.1 Confidentiality Mandate (绝密条款)**
*   **STRICTLY CONFIDENTIAL**: All Planning Documents, Constitutions, System Prompts, Execution Plans, and related strategies are classified.
*   **NO GITHUB**: These files MUST NEVER be committed to public repositories or shared externally.
*   **Enforcement**: Use `.gitignore` to block `docs/CONSTITUTION*`, `*PLAN*`, `*PROMPT*`.

**Art. 0.2 Language Mandate (语言统一指令)**
*   **ENGLISH ONLY**: All code, comments, variable names, log messages, and Frontend/Backend display text MUST be in English.
*   **No Exceptions**: Non-English characters in source code are forbidden (except in localized content files, if any).

**Art. 0.3 The Sidecar Mandate (挂车指令)**
*   **Workers**: Light/Fast Tasks ONLY (Routing, Queue, Static Delivery).
*   **Actions**: Heavy/Slow Tasks ONLY (Image Processing, NLP, Backup).
*   **R2**: The ONLY Shared Truth.
*   **Ban**: No Heavy Compute in Workers. No API/Serving in Actions.

-----

## 🏛️ Chapter 1: The Cloudflare Matrix (角色定义)

Each module has ONE specific role. Crossing boundaries is unconstitutional.

| Module | Role | Constitution V5.1.3 Definition | Status |
| :--- | :--- | :--- | :--- |
| **Workers** | **Commander** | Thin Brain. Routing, Queue coordination. NO heavy compute. | ✅ Core |
| **R2** | **Truth Vault** | SOLE source of truth. The Data Exchange Layer. | ✅ Core |
| **Actions** | **Heavy Artillery** | **Sidecar**. Offline heavy processing (Python/Rust). | ✅ New |
| **D1** | **Cold Vault** | Write-Only for background Harvester. **Frontend Read = Treason**. | ⚠️ Cold |
| **Queues** | **Safe Valve** | Async batch processing to prevent timeouts. | ✅ Core |
| **Pages** | **Static Shell** | UI Skeleton (Astro). Primary SEO carrier. | ✅ Core |
| **Cache Rules** | **CPU Shield** | Force-cache R2 content to save CPU. Priority > Workers. | ✅ Core |

-----

## 🏗️ Chapter 2: Infrastructure Hardening (基建加固)

**Art. 2.1 R2 Directory Standard (The Pagination Layout)**
All JSONs in `/cache/entities/*` and `/cache/rankings/*` **MUST be Gzipped** (`contentEncoding: gzip`).

```text
/cache/
 ├─ index/
 │   └─ index_hot.json                # Top 20k Only (< 500KB Gzip)
 ├─ entities/                         # Sharded by Type
 ├─ rankings/                         # Static Pagination
 ├─ sitemaps/                         # Sharded Sitemaps
```

**Art. 2.2 Cache Rules (The Golden Shield)**
Dashboard Configuration overrides Worker logic.
*   `cache/meta/*` → **BYPASS** (0s)
*   `cache/index/*` → **1 Hour**
*   `cache/entities/*` → **7 Days** (Browser 1 Day)
*   `cache/rankings/*` → **6 Hours**

**Art. 2.3 Queue Hydration (Flow Control)**
*   **Producer**: Dynamic Batch Size (100-400).
*   **Kill-Switch**: Stop if Backlog > 10,000 or CPU > 85%.
*   **Consumer**: Hash Check (Dedupe) -> Gzip -> R2 Write.

**Art. 2.4 The Sidecar Pattern (挂车模式)**
*   **Topology**: Workers (Commander) <-> R2 (Shared Truth) <-> GitHub Actions (Sidecar).
*   **Conservation**: Sidecar MUST use **List-Then-Compare** (Batch Check) before uploading to R2 to save Class A/B Ops.
*   **Safety**: Sidecar MUST use `actions/cache` and strictly limit concurrency.

-----

## 📜 Chapter 3: Protocol Iron Locks (核心铁律)

**Art. 3.1 Hot Index Upper Bound**
*   `index_hot.json` **MUST ≤ 20,000 items**.
*   Reason: Prevent Mobile Browser OOM.

**Art. 3.2 Client Search Timebox**
*   Web Worker search **MUST ≤ 50ms**.
*   Action: Terminate and show "Refine Search" if exceeded.

**Art. 3.3 Static Pagination Protocol**
*   Ranking Page Size **MUST ≤ 1,000**.
*   Max Pages per Category **MUST ≤ 50**.

**Art. 3.4 Class A Conservation Protocol**
*   **Sidecar Rule**: NEVER loop `HEAD` requests. ALWAYS use `ListObjects` batching.
*   **Goal**: Zero R2 Overage.

-----

## 💰 Chapter 4: Budget Roadmap (Target: $5.00/mo)

*   **Workers**: 60% Buffer.
*   **R2**: Hash Check + List-Then-Compare -> < 15GB + Zero Overage.
*   **Actions**: Free Tier (2000 min/mo) via Caching.

-----

**Ratified By:**
Helios (Chief Architect)
Grok 4 (Advisory Architect)
**Date**: 2025-12-16
