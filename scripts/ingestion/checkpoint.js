/**
 * V4.3.1 Checkpoint Manager
 * 
 * Manages R2-based checkpointing for L1 Harvester
 * Enables crash recovery and incremental collection
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const CHECKPOINT_BUCKET = 'ai-nexus-assets';
const CHECKPOINT_PREFIX = 'checkpoints/';

/**
 * Create S3 client for R2
 */
function createR2Client() {
    const accountId = process.env.CF_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY;
    const secretAccessKey = process.env.R2_SECRET_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
        console.warn('[Checkpoint] R2 credentials not configured, using local fallback');
        return null;
    }

    return new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    });
}

/**
 * Load checkpoint from R2
 * @param {string} harvesterId - Unique identifier for this harvester
 * @returns {Object|null} - Checkpoint data or null if not exists
 */
export async function loadCheckpoint(harvesterId) {
    const client = createR2Client();
    const key = `${CHECKPOINT_PREFIX}${harvesterId}.json`;

    if (!client) {
        // Fallback to local file
        try {
            const fs = await import('fs/promises');
            const data = await fs.readFile(`.checkpoint_${harvesterId}.json`, 'utf-8');
            console.log(`[Checkpoint] Loaded local checkpoint for ${harvesterId}`);
            return JSON.parse(data);
        } catch (e) {
            console.log(`[Checkpoint] No local checkpoint found for ${harvesterId}`);
            return null;
        }
    }

    try {
        const command = new GetObjectCommand({
            Bucket: CHECKPOINT_BUCKET,
            Key: key,
        });
        const response = await client.send(command);
        const body = await response.Body.transformToString();
        console.log(`[Checkpoint] Loaded R2 checkpoint for ${harvesterId}`);
        return JSON.parse(body);
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            console.log(`[Checkpoint] No R2 checkpoint found for ${harvesterId}`);
            return null;
        }
        console.error(`[Checkpoint] Error loading checkpoint: ${error.message}`);
        return null;
    }
}

/**
 * Save checkpoint to R2
 * @param {string} harvesterId - Unique identifier for this harvester
 * @param {Object} state - Checkpoint state to save
 */
export async function saveCheckpoint(harvesterId, state) {
    const client = createR2Client();
    const key = `${CHECKPOINT_PREFIX}${harvesterId}.json`;

    const checkpoint = {
        harvester_id: harvesterId,
        version: '4.3.1',
        timestamp: new Date().toISOString(),
        state,
    };

    const body = JSON.stringify(checkpoint, null, 2);

    if (!client) {
        // Fallback to local file
        try {
            const fs = await import('fs/promises');
            await fs.writeFile(`.checkpoint_${harvesterId}.json`, body);
            console.log(`[Checkpoint] Saved local checkpoint for ${harvesterId}`);
            return true;
        } catch (e) {
            console.error(`[Checkpoint] Error saving local checkpoint: ${e.message}`);
            return false;
        }
    }

    try {
        const command = new PutObjectCommand({
            Bucket: CHECKPOINT_BUCKET,
            Key: key,
            Body: body,
            ContentType: 'application/json',
        });
        await client.send(command);
        console.log(`[Checkpoint] Saved R2 checkpoint for ${harvesterId}`);
        return true;
    } catch (error) {
        console.error(`[Checkpoint] Error saving checkpoint: ${error.message}`);
        return false;
    }
}

/**
 * Create initial checkpoint state
 */
export function createInitialState() {
    return {
        strategy_index: 0,
        offset: 0,
        collected_ids: [],
        total_collected: 0,
        last_completed_strategy: null,
        started_at: new Date().toISOString(),
        stats: {
            api_calls: 0,
            rate_limit_hits: 0,
            errors: [],
        },
    };
}

/**
 * Merge new collected IDs with existing (deduplication)
 */
export function mergeCollectedIds(existing, newIds) {
    const set = new Set(existing);
    newIds.forEach(id => set.add(id));
    return Array.from(set);
}

export default {
    loadCheckpoint,
    saveCheckpoint,
    createInitialState,
    mergeCollectedIds,
};
