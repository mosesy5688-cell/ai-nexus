/**
 * V1.3 Repair Job - Contract Validation
 * 
 * Validates repair contracts and generates contract hashes.
 * 
 * @module unified-workflow/utils/repair-contract
 * @see REPAIR_JOB_IDENTITY_V1.3.md Section 5
 */

import type { RepairContract } from './repair-types';

/**
 * Generate SHA-256 hash for contract
 */
async function sha256(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a new repair contract
 */
export async function createRepairContract(
    targetPrimaryJobId: string,
    batchIndices: number[],
    reason: string
): Promise<RepairContract> {
    const contract: Omit<RepairContract, 'contract_hash'> = {
        target_primary_job_id: targetPrimaryJobId,
        repair_scope: {
            batch_indices: batchIndices.sort((a, b) => a - b),
        },
        reason,
        created_at: new Date().toISOString(),
    };

    // Generate contract hash from content
    const contractHash = await sha256(JSON.stringify(contract));

    return {
        ...contract,
        contract_hash: `sha256:${contractHash}`,
    };
}

/**
 * Verify contract hash integrity
 */
export async function verifyContractHash(
    contract: RepairContract
): Promise<boolean> {
    // Extract hash without prefix
    const expectedHash = contract.contract_hash.replace('sha256:', '');

    // Recreate contract without hash
    const contractContent: Omit<RepairContract, 'contract_hash'> = {
        target_primary_job_id: contract.target_primary_job_id,
        repair_scope: contract.repair_scope,
        reason: contract.reason,
        created_at: contract.created_at,
    };

    const actualHash = await sha256(JSON.stringify(contractContent));

    return expectedHash === actualHash;
}

/**
 * Validate contract structure
 */
export function validateContractStructure(contract: unknown): {
    valid: boolean;
    errors: string[];
} {
    const errors: string[] = [];

    if (!contract || typeof contract !== 'object') {
        return { valid: false, errors: ['Contract must be an object'] };
    }

    const c = contract as Record<string, unknown>;

    if (typeof c.target_primary_job_id !== 'string' || !c.target_primary_job_id) {
        errors.push('target_primary_job_id must be a non-empty string');
    }

    if (!c.repair_scope || typeof c.repair_scope !== 'object') {
        errors.push('repair_scope must be an object');
    } else {
        const scope = c.repair_scope as Record<string, unknown>;
        if (!Array.isArray(scope.batch_indices) || scope.batch_indices.length === 0) {
            errors.push('repair_scope.batch_indices must be a non-empty array');
        } else if (!scope.batch_indices.every(i => typeof i === 'number' && i >= 0)) {
            errors.push('repair_scope.batch_indices must contain non-negative integers');
        }
    }

    if (typeof c.reason !== 'string' || !c.reason) {
        errors.push('reason must be a non-empty string');
    }

    if (typeof c.contract_hash !== 'string' || !c.contract_hash.startsWith('sha256:')) {
        errors.push('contract_hash must be a string starting with sha256:');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

/**
 * Common repair reasons
 */
export const REPAIR_REASONS = {
    NETWORK_TIMEOUT: 'network_timeout',
    API_RATE_LIMIT: 'api_rate_limit',
    PARTIAL_FAILURE: 'partial_failure',
    DATA_CORRUPTION: 'data_corruption',
    MANUAL_REFRESH: 'manual_refresh',
} as const;
