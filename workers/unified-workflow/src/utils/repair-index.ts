/**
 * V1.3 Repair Job Identity - Module Index
 * 
 * Centralized exports for all repair job utilities.
 * 
 * @module unified-workflow/utils/repair
 * @version 1.3-LOCK
 */

// Types
export type {
    JobIdentity,
    OperationMode,
    AuthorityState,
    RevocationReason,
    PolicyDecision,
    PolicyReasonCode,
    CompositeManifest,
    RepairContract,
    PolicyDecisionResult,
    RepairHealthMetrics,
} from './repair-types';

// Authority State Machine
export {
    isValidTransition,
    submitForMerge,
    promoteToAuthoritative,
    revoke,
    checkTTLExpiry,
    getStateDescription,
} from './authority-state';

// Policy Engine
export {
    evaluateRepairPolicy,
    isGapFill,
    hasOverlap,
    getOverlappingBatches,
    validateContract,
} from './policy-engine';

// Composite Manifest
export {
    generateJobId,
    createPrimaryManifest,
    createRepairManifest,
    mergeManifests,
    verifyChecksum,
} from './composite-manifest';

// Repair Contract
export {
    createRepairContract,
    verifyContractHash,
    validateContractStructure,
    REPAIR_REASONS,
} from './repair-contract';

// Health Monitor
export {
    calculateHealthMetrics,
    getCleanupCandidates,
    getEscalationCandidates,
    generateHealthSummary,
} from './repair-health';

// Workflow Orchestrator
export {
    dryRunRepair,
    executeRepair,
    approveRepair,
    listPendingRepairs,
    type DryRunResult,
} from './repair-workflow';
