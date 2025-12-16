
import { Env, WorkflowResult } from '../config/types';

export async function logExecution(env: Env, result: WorkflowResult, eventId: string): Promise<void> {
    const safeWorkflowId = eventId || 'unknown';
    const safeStatus = result?.status || 'completed';
    const safeIngestCount = result?.ingest?.modelsIngested ?? 0;
    const safeFniCount = result?.fni?.modelsCalculated ?? 0;
    const safeDurationMs = result?.duration_ms ?? 0;

    console.log(`[Monitor] Logging: workflowId=${safeWorkflowId}, ingest=${safeIngestCount}, fni=${safeFniCount}`);

    try {
        await env.DB.prepare(`
            INSERT INTO workflow_logs (
                workflow_id, workflow_type, status, processed_count, duration_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(
            safeWorkflowId,
            'unified',
            safeStatus,
            safeIngestCount + safeFniCount,
            safeDurationMs
        ).run();

        console.log(`[Monitor] Logged successfully`);
    } catch (e) {
        console.error('[Monitor] Failed to log execution:', e);
    }
}
