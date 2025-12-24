/**
 * V1.3 Repair Job - Health Monitor
 * 
 * Generates health metrics and manages cleanup:
 * - Pending count, failure rate, overlap ratio
 * - 7d/30d trends
 * - REVOKED > 90 days → delete
 * 
 * @module unified-workflow/utils/repair-health
 * @see REPAIR_JOB_IDENTITY_V1.3.md Section 7
 */

import type {
    RepairHealthMetrics,
    CompositeManifest,
    AuthorityState
} from './repair-types';

/**
 * Calculate health metrics from manifests
 */
export function calculateHealthMetrics(
    manifests: CompositeManifest[],
    historicalFailureRate7d: number = 0,
    historicalFailureRate30d: number = 0
): RepairHealthMetrics {
    const pendingManifests = manifests.filter(
        m => m.authority.state === 'PENDING_MERGE'
    );

    const revokedManifests = manifests.filter(
        m => m.authority.state === 'REVOKED'
    );

    const totalRepairs = manifests.filter(
        m => m.job_identity === 'DERIVED'
    ).length;

    // Calculate failure rate (revoked / total repairs)
    const failureRate = totalRepairs > 0
        ? revokedManifests.length / totalRepairs
        : 0;

    // Calculate overlap ratio
    let overlappingCount = 0;
    for (const manifest of manifests) {
        if (manifest.job_identity === 'DERIVED' && manifest.composition.overlay_manifests.length > 1) {
            overlappingCount++;
        }
    }
    const overlapRatio = totalRepairs > 0 ? overlappingCount / totalRepairs : 0;

    // Calculate average merge time for promoted manifests
    const promotedManifests = manifests.filter(
        m => m.authority.state === 'AUTHORITATIVE' &&
            m.authority.promoted_at &&
            m.job_identity === 'DERIVED'
    );

    let avgMergeTimeHours = 0;
    if (promotedManifests.length > 0) {
        const totalHours = promotedManifests.reduce((sum, m) => {
            const created = new Date(m.created_at).getTime();
            const promoted = new Date(m.authority.promoted_at!).getTime();
            return sum + (promoted - created) / (1000 * 60 * 60);
        }, 0);
        avgMergeTimeHours = totalHours / promotedManifests.length;
    }

    return {
        metrics: {
            repair_pending_count: pendingManifests.length,
            repair_failure_rate: Math.round(failureRate * 100) / 100,
            overlap_ratio: Math.round(overlapRatio * 100) / 100,
            avg_merge_time_hours: Math.round(avgMergeTimeHours * 10) / 10,
        },
        trends: {
            repair_failure_rate_7d: historicalFailureRate7d,
            repair_failure_rate_30d: historicalFailureRate30d,
        },
        generated_at: new Date().toISOString(),
    };
}

/**
 * Identify manifests eligible for cleanup (REVOKED > 90 days)
 */
export function getCleanupCandidates(
    manifests: CompositeManifest[]
): CompositeManifest[] {
    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);

    return manifests.filter(m => {
        if (m.authority.state !== 'REVOKED') return false;
        if (!m.authority.revocation?.revoked_at) return false;

        const revokedAt = new Date(m.authority.revocation.revoked_at).getTime();
        return revokedAt < ninetyDaysAgo;
    });
}

/**
 * Identify manifests requiring TTL escalation
 */
export function getEscalationCandidates(
    manifests: CompositeManifest[]
): Array<{
    manifest: CompositeManifest;
    hoursInPending: number;
    action: 'notify' | 'reminder' | 'auto_revoke';
}> {
    const candidates: Array<{
        manifest: CompositeManifest;
        hoursInPending: number;
        action: 'notify' | 'reminder' | 'auto_revoke';
    }> = [];

    for (const manifest of manifests) {
        if (manifest.authority.state !== 'PENDING_MERGE') continue;

        const createdAt = new Date(manifest.created_at).getTime();
        const hoursInPending = (Date.now() - createdAt) / (1000 * 60 * 60);

        if (hoursInPending >= 72) {
            candidates.push({ manifest, hoursInPending, action: 'auto_revoke' });
        } else if (hoursInPending >= 48) {
            candidates.push({ manifest, hoursInPending, action: 'reminder' });
        } else if (hoursInPending >= 24) {
            candidates.push({ manifest, hoursInPending, action: 'notify' });
        }
    }

    return candidates;
}

/**
 * Generate health report summary
 */
export function generateHealthSummary(metrics: RepairHealthMetrics): string {
    const { metrics: m, trends: t } = metrics;

    const statusEmoji = m.repair_failure_rate < 0.05 ? '✅' :
        m.repair_failure_rate < 0.15 ? '⚠️' : '🔴';

    return `
${statusEmoji} Repair Health Report
========================
Pending Repairs: ${m.repair_pending_count}
Failure Rate: ${(m.repair_failure_rate * 100).toFixed(1)}%
Overlap Ratio: ${(m.overlap_ratio * 100).toFixed(1)}%
Avg Merge Time: ${m.avg_merge_time_hours.toFixed(1)} hours

Trends:
  7-day failure rate: ${(t.repair_failure_rate_7d * 100).toFixed(1)}%
  30-day failure rate: ${(t.repair_failure_rate_30d * 100).toFixed(1)}%

Generated: ${metrics.generated_at}
  `.trim();
}
