/**
 * V1.3 Repair Job - Policy Engine
 * 
 * Decides: AUTO_PROMOTE | REQUIRE_HUMAN | BLOCK
 * - Gap Fill → Auto-promote
 * - Overlap → Human approval required
 * 
 * @module unified-workflow/utils/policy-engine
 * @see REPAIR_JOB_IDENTITY_V1.3.md Section 4
 */

import type {
    PolicyDecisionResult,
    RepairContract,
    CompositeManifest
} from './repair-types';

/**
 * Evaluate repair contract and decide on promotion path
 */
export function evaluateRepairPolicy(
    contract: RepairContract,
    baseManifest: CompositeManifest,
    repairManifest: CompositeManifest
): PolicyDecisionResult {
    // Validate contract
    if (!contract.target_primary_job_id || !contract.repair_scope) {
        return {
            decision: 'BLOCK',
            reason_code: 'CONTRACT_INVALID',
            details: 'Missing required contract fields',
        };
    }

    // Check for overlaps - if repair batches already exist in base, require human
    const baseBatchIndices = new Set(
        baseManifest.virtual_batches.map(b => b.index)
    );
    const repairBatchIndices = contract.repair_scope.batch_indices;

    const hasOverlap = repairBatchIndices.some(idx => baseBatchIndices.has(idx));

    if (hasOverlap) {
        return {
            decision: 'REQUIRE_HUMAN',
            reason_code: 'OVERLAP',
            details: `Overlap detected at batch indices: ${repairBatchIndices.filter(idx => baseBatchIndices.has(idx)).join(', ')}`,
        };
    }

    // No overlap - this is a gap fill, auto-promote
    return {
        decision: 'AUTO_PROMOTE',
        reason_code: 'GAP_FILL',
        details: `Gap fill for batch indices: ${repairBatchIndices.join(', ')}`,
    };
}

/**
 * Quick check: is this a gap fill scenario?
 */
export function isGapFill(
    baseManifest: CompositeManifest,
    repairBatchIndices: number[]
): boolean {
    const baseBatchIndices = new Set(
        baseManifest.virtual_batches.map(b => b.index)
    );
    return !repairBatchIndices.some(idx => baseBatchIndices.has(idx));
}

/**
 * Quick check: is this an overlap scenario?
 */
export function hasOverlap(
    baseManifest: CompositeManifest,
    repairBatchIndices: number[]
): boolean {
    const baseBatchIndices = new Set(
        baseManifest.virtual_batches.map(b => b.index)
    );
    return repairBatchIndices.some(idx => baseBatchIndices.has(idx));
}

/**
 * Get overlapping batch indices
 */
export function getOverlappingBatches(
    baseManifest: CompositeManifest,
    repairBatchIndices: number[]
): number[] {
    const baseBatchIndices = new Set(
        baseManifest.virtual_batches.map(b => b.index)
    );
    return repairBatchIndices.filter(idx => baseBatchIndices.has(idx));
}

/**
 * Validate a repair contract structure
 */
export function validateContract(contract: RepairContract): {
    valid: boolean;
    errors: string[];
} {
    const errors: string[] = [];

    if (!contract.target_primary_job_id) {
        errors.push('target_primary_job_id is required');
    }

    if (!contract.repair_scope?.batch_indices?.length) {
        errors.push('repair_scope.batch_indices must not be empty');
    }

    if (!contract.reason) {
        errors.push('reason is required');
    }

    if (!contract.contract_hash) {
        errors.push('contract_hash is required');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}
