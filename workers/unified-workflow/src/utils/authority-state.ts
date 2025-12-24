/**
 * V1.3 Repair Job - Authority State Machine
 * 
 * States: NON_AUTHORITATIVE → PENDING_MERGE → AUTHORITATIVE → REVOKED
 * 
 * @module unified-workflow/utils/authority-state
 * @see REPAIR_JOB_IDENTITY_V1.3.md Section 3
 */

import type {
    AuthorityState,
    RevocationReason,
    CompositeManifest
} from './repair-types';

// Valid state transitions
const VALID_TRANSITIONS: Record<AuthorityState, AuthorityState[]> = {
    'NON_AUTHORITATIVE': ['PENDING_MERGE'],
    'PENDING_MERGE': ['AUTHORITATIVE', 'REVOKED'],
    'AUTHORITATIVE': ['REVOKED'],
    'REVOKED': [], // Terminal state
};

/**
 * Check if a state transition is valid
 */
export function isValidTransition(
    from: AuthorityState,
    to: AuthorityState
): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Transition manifest to PENDING_MERGE state
 * @throws Error if transition is invalid
 */
export function submitForMerge(
    manifest: CompositeManifest
): CompositeManifest {
    if (!isValidTransition(manifest.authority.state, 'PENDING_MERGE')) {
        throw new Error(
            `Invalid transition: ${manifest.authority.state} → PENDING_MERGE`
        );
    }

    return {
        ...manifest,
        authority: {
            ...manifest.authority,
            state: 'PENDING_MERGE',
        },
        updated_at: new Date().toISOString(),
    };
}

/**
 * Promote manifest to AUTHORITATIVE state
 * @throws Error if transition is invalid
 */
export function promoteToAuthoritative(
    manifest: CompositeManifest,
    promotedBy: string
): CompositeManifest {
    if (!isValidTransition(manifest.authority.state, 'AUTHORITATIVE')) {
        throw new Error(
            `Invalid transition: ${manifest.authority.state} → AUTHORITATIVE`
        );
    }

    return {
        ...manifest,
        authority: {
            ...manifest.authority,
            state: 'AUTHORITATIVE',
            promoted_at: new Date().toISOString(),
            promoted_by: promotedBy,
        },
        updated_at: new Date().toISOString(),
    };
}

/**
 * Revoke a manifest
 * @throws Error if transition is invalid
 */
export function revoke(
    manifest: CompositeManifest,
    reason: RevocationReason,
    revokedBy?: string
): CompositeManifest {
    if (!isValidTransition(manifest.authority.state, 'REVOKED')) {
        throw new Error(
            `Invalid transition: ${manifest.authority.state} → REVOKED`
        );
    }

    return {
        ...manifest,
        authority: {
            ...manifest.authority,
            state: 'REVOKED',
            revocation: {
                reason,
                revoked_at: new Date().toISOString(),
                revoked_by: revokedBy,
            },
        },
        updated_at: new Date().toISOString(),
    };
}

/**
 * Check if manifest is expired (TTL > 72 hours in PENDING_MERGE)
 */
export function checkTTLExpiry(manifest: CompositeManifest): {
    expired: boolean;
    hoursInPending: number;
    escalationLevel: 'none' | 'notify' | 'reminder' | 'auto_revoke';
} {
    if (manifest.authority.state !== 'PENDING_MERGE') {
        return { expired: false, hoursInPending: 0, escalationLevel: 'none' };
    }

    const createdAt = new Date(manifest.created_at).getTime();
    const now = Date.now();
    const hoursInPending = (now - createdAt) / (1000 * 60 * 60);

    let escalationLevel: 'none' | 'notify' | 'reminder' | 'auto_revoke' = 'none';

    if (hoursInPending >= 72) {
        escalationLevel = 'auto_revoke';
    } else if (hoursInPending >= 48) {
        escalationLevel = 'reminder';
    } else if (hoursInPending >= 24) {
        escalationLevel = 'notify';
    }

    return {
        expired: hoursInPending >= 72,
        hoursInPending,
        escalationLevel,
    };
}

/**
 * Get human-readable state description
 */
export function getStateDescription(state: AuthorityState): string {
    const descriptions: Record<AuthorityState, string> = {
        'NON_AUTHORITATIVE': 'Repair job created, not yet submitted for merge',
        'PENDING_MERGE': 'Awaiting human approval for merge',
        'AUTHORITATIVE': 'Approved and merged as authoritative data',
        'REVOKED': 'Revoked due to TTL expiry or manual rollback',
    };
    return descriptions[state];
}
