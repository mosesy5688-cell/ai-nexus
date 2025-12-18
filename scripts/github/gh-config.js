/**
 * GitHub Enrichment Configuration & Metrics
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CONFIG = {
    DB_NAME: 'ai-nexus-db',
    BATCH_SIZE: 10,
    CONCURRENT_LIMIT: 5,  // Max concurrent API calls
    DELAY_BETWEEN_BATCHES_MS: 2000,
    MAX_RETRIES: 3,
    INITIAL_BACKOFF_MS: 1000,
    CHECKPOINT_FILE: path.join(__dirname, '../.enrich-checkpoint.json'), // Adjusted path
};

// Metrics state
export const metrics = {
    totalProcessed: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    startTime: Date.now(),
    endTime: null,
    apiCallsUsed: 0,
    rateLimitRemaining: 0,
    errors: []
};

// Sleep helper
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
