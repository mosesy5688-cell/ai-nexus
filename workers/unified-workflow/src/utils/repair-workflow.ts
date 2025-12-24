/**
 * V1.3 Repair Job - Workflow Orchestrator
 * 
 * Main entry point for repair operations:
 * 1. Create repair contract
 * 2. Generate repair manifest
 * 3. Evaluate policy (auto-promote or require human)
 * 4. Submit for merge or auto-promote
 * 
 * @module unified-workflow/utils/repair-workflow
 * @see REPAIR_JOB_IDENTITY_V1.3.md
 */

import type {
    CompositeManifest,
    RepairContract,
    PolicyDecisionResult,
    OperationMode
} from './repair-types';
import { createRepairContract, verifyContractHash } from './repair-contract';
import { createRepairManifest, createPrimaryManifest } from './composite-manifest';
import { evaluateRepairPolicy, validateContract } from './policy-engine';
import { submitForMerge, promoteToAuthoritative, checkTTLExpiry } from './authority-state';
import { Env } from '../config/types';
import { writeToR2 } from './gzip';

/**
 * Dry-run mode result
 */
export interface DryRunResult {
    success: boolean;
    contract: RepairContract;
    manifest: CompositeManifest;
    policyDecision: PolicyDecisionResult;
    errors: string[];
    warnings: string[];
}

/**
 * Execute a repair job in dry-run mode
 */
export async function dryRunRepair(
    env: Env,
    targetJobId: string,
    batchIndices: number[],
    reason: string
): Promise<DryRunResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
        // Get base manifest from R2
        const baseManifestPath = `manifest/L1/${targetJobId}.json`;
        const baseManifestObj = await env.R2_ASSETS.get(baseManifestPath);

        if (!baseManifestObj) {
            errors.push(`Base manifest not found: ${baseManifestPath}`);
            return {
                success: false,
                contract: {} as RepairContract,
                manifest: {} as CompositeManifest,
                policyDecision: { decision: 'BLOCK', reason_code: 'CONTRACT_INVALID' },
                errors,
                warnings,
            };
        }

        const baseManifest = JSON.parse(await baseManifestObj.text()) as CompositeManifest;

        // Create contract
        const contract = await createRepairContract(targetJobId, batchIndices, reason);

        // Validate contract
        const validationResult = validateContract(contract);
        if (!validationResult.valid) {
            errors.push(...validationResult.errors);
        }

        // Create repair manifest
        const repairManifest = await createRepairManifest(contract, baseManifest);

        // Evaluate policy
        const policyDecision = evaluateRepairPolicy(contract, baseManifest, repairManifest);

        // Add warnings for overlap
        if (policyDecision.decision === 'REQUIRE_HUMAN') {
            warnings.push(`Overlap detected: ${policyDecision.details}`);
        }

        return {
            success: errors.length === 0,
            contract,
            manifest: repairManifest,
            policyDecision,
            errors,
            warnings,
        };
    } catch (error) {
        errors.push(`Dry run failed: ${(error as Error).message}`);
        return {
            success: false,
            contract: {} as RepairContract,
            manifest: {} as CompositeManifest,
            policyDecision: { decision: 'BLOCK', reason_code: 'CONTRACT_INVALID' },
            errors,
            warnings,
        };
    }
}

/**
 * Execute a repair job
 */
export async function executeRepair(
    env: Env,
    targetJobId: string,
    batchIndices: number[],
    reason: string,
    operationMode: OperationMode = 'REPAIR'
): Promise<{
    success: boolean;
    jobId?: string;
    manifest?: CompositeManifest;
    policyDecision?: PolicyDecisionResult;
    error?: string;
}> {
    try {
        // Dry run first
        const dryRun = await dryRunRepair(env, targetJobId, batchIndices, reason);

        if (!dryRun.success) {
            return {
                success: false,
                error: dryRun.errors.join('; '),
            };
        }

        let manifest = dryRun.manifest;

        // Apply policy decision
        if (dryRun.policyDecision.decision === 'AUTO_PROMOTE') {
            // Gap fill - auto-promote
            manifest = submitForMerge(manifest);
            manifest = promoteToAuthoritative(manifest, 'system-auto');
            console.log(`[V1.3] Auto-promoted repair job: ${manifest.job_id}`);
        } else if (dryRun.policyDecision.decision === 'REQUIRE_HUMAN') {
            // Overlap - submit for human review
            manifest = submitForMerge(manifest);
            console.log(`[V1.3] Repair job awaiting human approval: ${manifest.job_id}`);
        } else {
            // Blocked
            return {
                success: false,
                error: `Repair blocked: ${dryRun.policyDecision.reason_code}`,
            };
        }

        // Save manifest to R2
        const manifestPath = `manifest/repair/${manifest.job_id}.json`;
        await writeToR2(env, manifestPath, manifest);

        // Save contract to R2
        const contractPath = `manifest/repair/${manifest.job_id}.contract.json`;
        await writeToR2(env, contractPath, dryRun.contract);

        return {
            success: true,
            jobId: manifest.job_id,
            manifest,
            policyDecision: dryRun.policyDecision,
        };
    } catch (error) {
        return {
            success: false,
            error: (error as Error).message,
        };
    }
}

/**
 * Approve a pending repair job (human action)
 */
export async function approveRepair(
    env: Env,
    repairJobId: string,
    approvedBy: string
): Promise<{
    success: boolean;
    manifest?: CompositeManifest;
    error?: string;
}> {
    try {
        // Get repair manifest
        const manifestPath = `manifest/repair/${repairJobId}.json`;
        const manifestObj = await env.R2_ASSETS.get(manifestPath);

        if (!manifestObj) {
            return { success: false, error: 'Repair manifest not found' };
        }

        let manifest = JSON.parse(await manifestObj.text()) as CompositeManifest;

        // Check state
        if (manifest.authority.state !== 'PENDING_MERGE') {
            return {
                success: false,
                error: `Cannot approve: current state is ${manifest.authority.state}`
            };
        }

        // Check TTL
        const ttlCheck = checkTTLExpiry(manifest);
        if (ttlCheck.expired) {
            return { success: false, error: 'Repair job TTL expired (72 hours)' };
        }

        // Promote to authoritative
        manifest = promoteToAuthoritative(manifest, approvedBy);

        // Save updated manifest
        await writeToR2(env, manifestPath, manifest);

        console.log(`[V1.3] Repair job approved: ${repairJobId} by ${approvedBy}`);

        return {
            success: true,
            manifest,
        };
    } catch (error) {
        return {
            success: false,
            error: (error as Error).message,
        };
    }
}

// Re-export from repair-queries for backwards compatibility
export { listPendingRepairs, getRepairManifest, getBaseManifest } from './repair-queries';
