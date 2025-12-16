
# 📘 Free2AITools Project Handover (V5.1.3)

**Codename**: The Knowledge OS (Fortress + Sidecar Edition)
**Status**: 🟢 **SECURE & OPERATIONAL**
**Date**: 2025-12-16

---

## 1. Core Architecture (V5.1.3)

We operate on a **Hybrid Cloud Fortress** model ("Commander-Sidecar Pattern").

### 👑 The Commander (Cloudflare Workers)
*   **Role**: Real-time request handling, routing, queue coordination.
*   **Constraint**: NO heavy compute. max 10ms CPU.
*   **Location**: `workers/unified-workflow/`

### 🚛 The Sidecar (GitHub Actions + Python)
*   **Role**: Heavy offline processing (Image resizing, Backups, NLP).
*   **Constraint**: **Class A Conservation Protocol** (Must use `ListObjects` before `PUT`).
*   **Location**: `.github/workflows/sidecar.yml`, `scripts/sidecar/*.py`

### 🏛️ The Truth Vault (R2 Storage)
*   **Role**: The ONLY data exchange layer.
*   **Constraint**: All JSONs must be Gzipped.

### ❄️ The Cold Vault (D1 Database)
*   **Role**: Write-only storage for harvesters.
*   **Strict Rule**: **Frontend NEVER reads D1**.

---

## 2. Security Protocols (Iron Laws)

**Art. 0.1 Confidentiality Mandate**
*   **Rule**: NEVER commit files matching `*CONSTITUTION*`, `*PLAN*`, `*STRATEGY*`, `*PROMPT*` to git.
*   **Enforcement**: Strict `.gitignore` rules are active.
*   **Verification**: Run `git check-ignore docs/CONSTITUTION_TEST.md` to verify.

**Art. 0.2 Language Mandate**
*   **Rule**: English ONLY for code, comments, and logs.

**Art 2.5.4 Class A Conservation**
*   **Rule**: Sidecar scripts must NEVER loop `HEAD` requests. Use `ListObjects` batching.

---

## 3. Operational status

| Component | Status | Note |
| :--- | :--- | :--- |
| **Frontend** | ✅ Healthy | CES V5.1.2 Compliant (API D1 Exempted). |
| **Harvester** | ⚠️ Monitoring | L1 Harvester runs nightly. |
| **Sidecar** | ✅ Installed | `media_processor.py`, `backup_vault.py` ready. |
| **CI/CD** | ✅ Active | `ces-check.cjs` enforces rules on every push. |

---

## 4. Next Steps for New Agent

1.  **Configure Secrets**:
    *   Ensure `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` are set in GitHub Secrets.
    *   Ensure `R2_ENDPOINT` is set in GitHub Variables.

2.  **Monitor Sidecar**:
    *   Watch the `Operation Sidecar` workflow (Cron: 01:00 UTC).
    *   Verify `backup_vault.py` is creating snapshots in `backups/`.

3.  **Continue Refactoring**:
    *   Check `task.md` for "Operation Renovate".
    *   Files > 250 lines need splitting.

---

## 5. Development Command Cheat Sheet

*   **Audit Compliance**: `npm run ces`
*   **Deploy**: `npm run deploy` (via GitHub Actions)
*   **Test**: `npm run test`
*   **Dev Server**: `npm run dev`

---

*Verified & Handed Over by Helios (V5.1.3)*
