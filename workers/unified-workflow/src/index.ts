
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Env, WorkflowResult } from './config/types';
import { runIngestionStep } from './steps/ingestion';
import { runFNIStep } from './steps/fni';
import { logExecution } from './steps/monitor';
import { runPrecomputeStep } from './steps/precompute';
import { consumeHydrationQueue } from './consumers/hydration';
import { consumeIngestionQueue } from './consumers/ingestion';  // V7.1
import { handleSearch } from './routes/search';
import { handleRelations } from './routes/relations';

// CES V5.1.2: Modular Step Architecture (Orchestrator Only)

export class UnifiedWorkflow extends WorkflowEntrypoint<Env> {
    async run(event: WorkflowEvent<{}>, step: WorkflowStep): Promise<WorkflowResult> {
        const startTime = Date.now();
        let result: WorkflowResult = { status: 'pending', duration_ms: 0 };

        const env = this.env;

        // L1 Checkpoint
        const checkpoint = await step.do('l1-load-checkpoint', async (): Promise<{ lastId: string | null; processedCount: number }> => {
            try {
                const f = await env.R2_ASSETS.get('checkpoint.json');
                return (f ? await f.json() : { lastId: null, processedCount: 0 }) as { lastId: string | null; processedCount: number };
            } catch { return { lastId: null, processedCount: 0 }; }
        });

        // Step 1: Ingest
        const ingestMetrics = await step.do('ingest-raw-data', async () => {
            return await runIngestionStep(env, checkpoint);
        });
        result.ingest = ingestMetrics;

        // L1 Save Checkpoint (Simplified inline)
        await step.do('l1-save-checkpoint', async () => {
            const newCp = {
                lastId: ingestMetrics.filesProcessed > 0 ? null : (checkpoint?.lastId || null),
                processedCount: (checkpoint?.processedCount || 0) + ingestMetrics.filesProcessed
            };
            await env.R2_ASSETS.put('checkpoint.json', JSON.stringify(newCp));
        });

        // Step 2: FNI Coverage
        const fniMetrics = await step.do('calculate-fni', async () => {
            return await runFNIStep(env);
        });

        result.fni = fniMetrics;

        // Step 3: Monitor & Log
        result.duration_ms = Date.now() - startTime;
        result.status = 'completed';

        await step.do('log-execution', async () => {
            await logExecution(env, result, (event as any).id);
        });

        // Step 4: L8 Precompute (Hungry Mode - Every Run)
        await step.do('precompute-cache', async () => {
            await runPrecomputeStep(env);
        });

        return result;
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname.slice(1);

        // Core Orchestrator Routes
        if (url.pathname === '/trigger') {
            await env.UNIFIED_WORKFLOW.create();
            return new Response('Triggered');
        }

        // Modular Route Handlers
        if (path.startsWith('api/search')) return await handleSearch(request, env);
        if (path.startsWith('api/relations/')) return await handleRelations(request, env);

        // Static Content Routes (R2 Proxy)
        if (path.startsWith('sitemaps/') || path.startsWith('api/cache/')) {
            return await handleStatic(path, env);
        }

        return new Response('Unified Workflow V6.0 (Orchestrator)\nEndpoints: /trigger, /api/search, /api/relations/, /sitemap*.xml');
    },

    async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
        const pause = await env.KV?.get('SYSTEM_PAUSE');
        if (pause === 'true') {
            console.log('[System] SYSTEM_PAUSE active. Aborting scheduled run.');
            return;
        }
        console.log('[Cron] Triggering workflow...');
        await env.UNIFIED_WORKFLOW.create();
    },

    async queue(batch: any, env: Env): Promise<void> {
        const pause = await env.KV?.get('SYSTEM_PAUSE');
        if (pause === 'true') {
            console.log('[System] SYSTEM_PAUSE active. Aborting queue consumption.');
            return;
        }

        const queueName = batch.queue;
        if (queueName === 'ai-nexus-ingestion-queue') await consumeIngestionQueue(batch, env);
        else await consumeHydrationQueue(batch, env);
    }
};

/**
 * Handle static content and R2 cache proxies to reduce index line count
 */
async function handleStatic(path: string, env: Env): Promise<Response> {
    const isSitemap = path.startsWith('sitemaps/');
    const cacheKey = isSitemap ? path : path.replace('api/', '');
    const object = await env.R2_ASSETS.get(cacheKey);

    if (!object) return new Response('Content not found', { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Content-Type', isSitemap ? 'application/xml' : 'application/json');
    headers.set('Cache-Control', isSitemap ? 'public, max-age=3600' : 'public, max-age=300');
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(object.body, { headers });
}
