
# 🏗️ Free2AITools System Architecture (V5.1.3)

**Status**: 🟢 **Operational**
**Architect**: Helios
**Protocol**: The Fortress Protocol (Sidecar Edition)

-----

## 1. High-Level Topology (混合云堡垒)

The system follows a **"Commander-Sidecar"** pattern, leveraging Cloudflare for speed and GitHub Actions for power, united by R2.

```mermaid
graph TD
    User[User / Browser] -->|HTTPS| CF[Cloudflare Workers (Commander)]
    CF -->|Read| R2[R2 Storage (Truth Vault)]
    
    subgraph "Sidecar Layer (GitHub Actions)"
        GH[Python Assets] -->|List-Then-Compare| R2
        GH -->|Heavy Process| GH
    end
    
    subgraph "Cold Layer"
        D1[D1 Database] -->|Write-Only| R2
    end
    
    CF -->|Enqueue| Q[Queues]
    Q -->|Consumer| R2
```

## 2. Core Modules

### 2.1 The Commander (Workers)
*   **Role**: Routing, hydration, static delivery.
*   **Constraint**: No heavy compute (>10ms CPU).
*   **Key File**: `workers/unified-workflow/src/index.ts`

### 2.2 The Sidecar (GitHub Actions)
*   **Role**: Heavy artillery (Image processing, NLP, Backup).
*   **Constraint**: Offline only. Must respect **Class A Conservation** (List-Then-Compare).
*   **Key Files**: `scripts/sidecar/*.py`, `.github/workflows/sidecar.yml`

### 2.3 The Truth Vault (R2)
*   **Role**: The only data exchange layer.
*   **Schema**:
    *   `cache/index/index_hot.json` (Search)
    *   `cache/entities/` (Data)
    *   `images/` (Processed Assets)

### 2.4 The Cold Vault (D1)
*   **Role**: Write-only ledger for harvesters.
*   **Rule**: Frontend NEVER reads D1.

-----

## 3. Constitutional Rulings

### 3.1 The Sidecar Ruling (2025-12-16)
*   **Source**: `docs/AUDIT_V5.1.3_SIDECAR_FINAL.md`
*   **Verdict**: Python scripts are ALLOWED in `scripts/sidecar/` provided they use `ListObjects` before `PUT` to conserve Class A ops.

### 3.2 The D1 Ban (2025-12-15)
*   **Source**: `docs/CONSTITUTION_V5.1.1.md`
*   **Verdict**: Direct D1 access from Frontend is ACT OF TREASON. API routes are exempted for admin/health checks.
