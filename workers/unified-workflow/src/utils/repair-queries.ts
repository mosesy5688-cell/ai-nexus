/**
 * V1.3 Repair Job - R2 Query Utilities
 * 
 * Extracted from repair-workflow.ts for CES Art 5.1 compliance.
 * 
 * @module unified-workflow/utils/repair-queries
 */

import type { CompositeManifest } from './repair-types';
import { Env } from '../config/types';

/**
 * List pending repair jobs from R2
 */
export async function listPendingRepairs(
    env: Env
): Promise<CompositeManifest[]> {
    const list = await env.R2_ASSETS.list({ prefix: 'manifest/repair/' });
    const pending: CompositeManifest[] = [];

    for (const object of list.objects) {
        if (!object.key.endsWith('.json') || object.key.endsWith('.contract.json')) {
            continue;
        }

        const manifestObj = await env.R2_ASSETS.get(object.key);
        if (manifestObj) {
            const manifest = JSON.parse(await manifestObj.text()) as CompositeManifest;
            if (manifest.authority.state === 'PENDING_MERGE') {
                pending.push(manifest);
            }
        }
    }

    return pending;
}

/**
 * Get a specific repair manifest from R2
 */
export async function getRepairManifest(
    env: Env,
    repairJobId: string
): Promise<CompositeManifest | null> {
    const manifestPath = `manifest/repair/${repairJobId}.json`;
    const manifestObj = await env.R2_ASSETS.get(manifestPath);

    if (!manifestObj) {
        return null;
    }

    return JSON.parse(await manifestObj.text()) as CompositeManifest;
}

/**
 * Get base manifest from R2
 */
export async function getBaseManifest(
    env: Env,
    targetJobId: string
): Promise<CompositeManifest | null> {
    const baseManifestPath = `manifest/L1/${targetJobId}.json`;
    const baseManifestObj = await env.R2_ASSETS.get(baseManifestPath);

    if (!baseManifestObj) {
        return null;
    }

    return JSON.parse(await baseManifestObj.text()) as CompositeManifest;
}
