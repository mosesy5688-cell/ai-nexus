/**
 * V1.3 Repair Job Identity - Type Definitions
 * 
 * @module unified-workflow/utils/repair-types
 * @see REPAIR_JOB_IDENTITY_V1.3.md
 */

// Job Identity
export type JobIdentity = 'PRIMARY' | 'DERIVED';

// Operation Mode
export type OperationMode = 'REPAIR' | 'PATCH' | 'RECOMPUTE' | 'SNAPSHOT';

// Authority States (State Machine)
export type AuthorityState =
    | 'NON_AUTHORITATIVE'
    | 'PENDING_MERGE'
    | 'AUTHORITATIVE'
    | 'REVOKED';

// Revocation Reasons
export type RevocationReason =
    | 'TTL_EXPIRED'
    | 'MANUAL_ROLLBACK'
    | 'BASE_TAMPERED';

// Policy Decisions
export type PolicyDecision = 'AUTO_PROMOTE' | 'REQUIRE_HUMAN' | 'BLOCK';
export type PolicyReasonCode = 'GAP_FILL' | 'OVERLAP' | 'CONTRACT_INVALID';

// Composite Manifest Schema
export interface CompositeManifest {
    version: 'INTEGRITY-V1.3';
    job_id: string;
    job_identity: JobIdentity;
    operation_mode: OperationMode;

    composition: {
        base_manifest: string;
        overlay_manifests: string[];
        strategy: 'batch_level_replacement';
        fingerprint: string;
    };

    virtual_batches: Array<{
        index: number;
        source: 'primary' | 'repair';
    }>;

    truth_anchor: {
        root_job_id: string;
        generation: number;
    };

    authority: {
        state: AuthorityState;
        promoted_at?: string;
        promoted_by?: string;
        revocation?: {
            reason: RevocationReason;
            revoked_at: string;
            revoked_by?: string;
        };
    };

    checksum: {
        total_hash: string;
        chain: {
            base_hash: string;
            overlay_hashes: string[];
            chain_hash: string;
        };
    };

    created_at: string;
    updated_at: string;
}

// Repair Contract
export interface RepairContract {
    target_primary_job_id: string;
    repair_scope: {
        batch_indices: number[];
    };
    reason: string;
    contract_hash: string;
    created_at: string;
}

// Policy Decision Result
export interface PolicyDecisionResult {
    decision: PolicyDecision;
    reason_code: PolicyReasonCode;
    details?: string;
}

// Health Metrics
export interface RepairHealthMetrics {
    metrics: {
        repair_pending_count: number;
        repair_failure_rate: number;
        overlap_ratio: number;
        avg_merge_time_hours: number;
    };
    trends: {
        repair_failure_rate_7d: number;
        repair_failure_rate_30d: number;
    };
    generated_at: string;
}
