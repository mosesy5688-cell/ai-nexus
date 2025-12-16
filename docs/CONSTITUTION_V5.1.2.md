# 📜 Free2AITools Constitution V5.1.2 (The Fortress Protocol)

**Codename**: The Five-Dollar Sovereign (Fortress Edition)
**Theme**: Million-Scale Reality Check (百万级现实校验)
**Objective**: 1,000,000 Entities, Zero Overage, Zero Client OOM, Zero Runaway Risk
**Effective Date**: 2025-12-16
**Status**: 🟢 **FROZEN FOR EXECUTION**

-----

## 🚫 Article 0: Non-Negotiable Mandates (零容忍指令)

**Art. 0.1 Confidentiality Mandate (绝密条款)**
*   **STRICTLY CONFIDENTIAL**: All Planning Documents, Constitutions, System Prompts, Execution Plans, and related strategies are classified.
*   **NO GITHUB**: These files MUST NEVER be committed to public repositories or shared externally.
*   **Enforcement**: Use `.gitignore` to block `docs/CONSTITUTION*`, `*PLAN*`, `*PROMPT*`.

**Art. 0.2 Language Mandate (语言统一指令)**
*   **ENGLISH ONLY**: All code, comments, variable names, log messages, and Frontend/Backend display text MUST be in English.
*   **No Exceptions**: Non-English characters in source code are forbidden (except in localized content files, if any).

-----

## 🏛️ Chapter 1: The Cloudflare Matrix (角色定义)

Each module has ONE specific role. Crossing boundaries is unconstitutional.

| Module | Role | Constitution V5.1.2 Definition | Status |
| :--- | :--- | :--- | :--- |
| **Workers** | **Thin Brain** | Routing, simple logic, Queue consumption. NO heavy compute. | ✅ Core |
| **R2** | **Materialized Truth** | SOLE source of truth for JSON/HTML. Replaces DB reads. | ✅ Core |
| **D1** | **Cold Vault** | Write-Only for background Harvester. **Frontend Read = Treason**. | ⚠️ Limited |
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
 │   ├─ model/
 ├─ rankings/                         # Static Pagination
 │   ├─ text-generation/
 │   │   ├─ meta.json                 # { total: 50k, pages: 50 }
 │   │   ├─ p1.json                   # Top 1-1000
 │   │   └─ ... (max p50)
 ├─ sitemaps/                         # Sharded Sitemaps
```

**Art. 2.2 Cache Rules (The Golden Shield)**
Dashboard Configuration overrides Worker logic.
*   `cache/meta/*` → **BYPASS** (0s)
*   `cache/index/*` → **1 Hour**
*   `cache/entities/*` → **7 Days** (Browser 1 Day)
*   `cache/rankings/*` → **6 Hours**
*   `api/search` → **BYPASS** (Forbidden Endpoint)

**Art. 2.3 Queue Hydration (Flow Control)**
*   **Producer**: Dynamic Batch Size (100-400).
*   **Kill-Switch**: Stop if Backlog > 10,000 or CPU > 85%.
*   **Consumer**: Hash Check (Dedupe) -> Gzip -> R2 Write.

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

**Art. 3.4 Global Hydration Kill-Switch**
*   Trigger: CPU > 85% OR Backlog > 10,000 OR Cost > $4.80.
*   Action: `SYSTEM_PAUSE` KV stops Producer.

-----

## 💰 Chapter 4: Budget Roadmap (Target: $5.00/mo)

*   **Workers**: 60% Buffer.
*   **R2**: Hash Check + Orphans Purge -> < 15GB.
*   **D1**: **Zero Frontend Reads**.

-----

**Ratified By:**
Helios (Chief Architect)
Grok 4 (Advisory Architect)
**Date**: 2025-12-16
