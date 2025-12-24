/**
 * L8 Hydration Manifest Utility
 * 
 * V1.2: Enhanced manifest granularity for L8 worker
 * Tracks entity-level hashes and input manifest references
 * 
 * @module utils/hydration-manifest
 */

import { Env } from '../config/types';
import { createHash } from 'crypto';

export interface HydrationManifest {
    version: string;
    stage: 'L8';
    started_at: string;
    completed_at?: string;
    status: 'running' | 'complete' | 'partial';
    input: {
        manifest_ref: string;
        manifest_status: string;
    };
    output: {
        total_processed: number;
        total_failed: number;
        cache_path: string;
    };
    batches: HydrationBatch[];
    failed_entities: string[];
    checksum?: {
        algorithm: string;
        mode: string;
        total_hash: string;
    };
}

export interface HydrationBatch {
    batch_id: number;
    processed_at: string;
    entity_count: number;
    entity_hashes: EntityHashSnapshot[];
    success_count: number;
    failure_count: number;
}

export interface EntityHashSnapshot {
    entity_id: string;
    content_hash: string;
    cache_path: string;
}

// In-memory manifest storage (per worker invocation)
let currentManifest: HydrationManifest | null = null;

/**
 * Initialize hydration manifest for a new run
 */
export function initHydrationManifest(inputManifestRef: string, inputStatus: string): HydrationManifest {
    currentManifest = {
        version: 'INTEGRITY-V1.2',
        stage: 'L8',
        started_at: new Date().toISOString(),
        status: 'running',
        input: {
            manifest_ref: inputManifestRef,
            manifest_status: inputStatus
        },
        output: {
            total_processed: 0,
            total_failed: 0,
            cache_path: 'cache/'
        },
        batches: [],
        failed_entities: []
    };
    return currentManifest;
}

/**
 * Compute content hash for an entity
 */
export function computeEntityHash(entity: any): string {
    const content = JSON.stringify(entity);
    return 'sha256:' + createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Record a processed batch
 */
export function recordHydrationBatch(
    batchId: number,
    entities: Array<{ id: string; hash: string; path: string }>,
    failedIds: string[]
): void {
    if (!currentManifest) return;

    const batch: HydrationBatch = {
        batch_id: batchId,
        processed_at: new Date().toISOString(),
        entity_count: entities.length + failedIds.length,
        entity_hashes: entities.map(e => ({
            entity_id: e.id,
            content_hash: e.hash,
            cache_path: e.path
        })),
        success_count: entities.length,
        failure_count: failedIds.length
    };

    currentManifest.batches.push(batch);
    currentManifest.output.total_processed += entities.length;
    currentManifest.output.total_failed += failedIds.length;
    currentManifest.failed_entities.push(...failedIds);
}

/**
 * Finalize manifest with checksum
 */
export function finalizeHydrationManifest(): HydrationManifest | null {
    if (!currentManifest) return null;

    currentManifest.completed_at = new Date().toISOString();
    currentManifest.status = currentManifest.failed_entities.length > 0 ? 'partial' : 'complete';

    // Compute total_hash from all batch hashes
    const allHashes = currentManifest.batches
        .flatMap(b => b.entity_hashes.map(e => e.content_hash))
        .sort()
        .join('');

    currentManifest.checksum = {
        algorithm: 'sha256',
        mode: 'ordered-concat',
        total_hash: 'sha256:' + createHash('sha256').update(allHashes).digest('hex')
    };

    return currentManifest;
}

/**
 * Write manifest to R2
 */
export async function writeHydrationManifest(env: Env, jobId: string): Promise<void> {
    const manifest = finalizeHydrationManifest();
    if (!manifest) return;

    const path = `manifest/L8/${jobId}.json`;
    const content = JSON.stringify(manifest, null, 2);

    await env.R2_ASSETS.put(path, content, {
        httpMetadata: { contentType: 'application/json' }
    });

    console.log(`[Manifest] Written L8 manifest: ${path}`);
}

export { currentManifest };
