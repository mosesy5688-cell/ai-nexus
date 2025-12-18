
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Env, WorkflowResult } from './config/types';
import { runIngestionStep } from './steps/ingestion';
import { runFNIStep } from './steps/fni';
import { logExecution } from './steps/monitor';
import { runPrecomputeStep } from './steps/precompute';
import { consumeHydrationQueue } from './consumers/hydration';

// CES V5.1.2: Modular Step Architecture (Orchestrator Only)

export class UnifiedWorkflow extends WorkflowEntrypoint<Env> {
    async run(event: WorkflowEvent<{}>, step: WorkflowStep): Promise<WorkflowResult> {
        const startTime = Date.now();
        let result: WorkflowResult = { status: 'pending', duration_ms: 0 };

        const env = this.env;

        // L1 Checkpoint
        const checkpoint = await step.do('l1-load-checkpoint', async () => {
            // simplified inline or move to utils if needed, keeping inline for visibility as it's small
            try {
                const f = await env.R2_ASSETS.get('checkpoint.json');
                return f ? await f.json() : { lastId: null, processedCount: 0 };
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
                lastId: ingestMetrics.filesProcessed > 0 ? null : checkpoint.lastId,
                processedCount: (checkpoint.processedCount || 0) + ingestMetrics.filesProcessed
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
        const path = url.pathname.slice(1); // remove leading slash

        // Route: Sitemaps (sitemaps/sitemap-index.xml, sitemaps/sitemap-models-1.xml)
        // Served directly from 'sitemaps/' directory in R2
        if (path.startsWith('sitemaps/')) {
            const object = await env.R2_ASSETS.get(path);
            if (!object) return new Response('Sitemap not found', { status: 404 });

            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set('etag', object.httpEtag);
            headers.set('Content-Type', 'application/xml');
            // Longer cache for shards, shorter for index handled by revalidation? 
            // Simplified: 1 hour cache, stale-while-revalidate 1 day
            headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');

            return new Response(object.body, { headers });
        }

        // Route: API Cache (E.g. /api/cache/trending.json -> cache/trending.json)
        if (path.startsWith('api/cache/')) {
            const cacheKey = path.replace('api/', ''); // cache/trending.json
            const object = await env.R2_ASSETS.get(cacheKey);
            if (!object) return new Response('Cache not found', { status: 404 });

            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set('etag', object.httpEtag);
            headers.set('Content-Type', 'application/json');
            // 5 min cache for trending
            headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');
            headers.set('Access-Control-Allow-Origin', '*');

            return new Response(object.body, { headers });
        }

        if (url.pathname === '/trigger') {
            await env.UNIFIED_WORKFLOW.create();
            return new Response('Triggered');
        }
        return new Response('Unified Workflow V6.0 (Orchestrator)\nEndpoints: /trigger, /sitemap*.xml');
    },

    async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
        const pause = await env.KV.get('SYSTEM_PAUSE');
        if (pause === 'true') {
            console.log('[System] SYSTEM_PAUSE active. Aborting scheduled run.');
            return;
        }

        console.log('[Cron] Triggering workflow...');
        await env.UNIFIED_WORKFLOW.create();
    },

    async queue(batch: any, env: Env): Promise<void> {
        const pause = await env.KV.get('SYSTEM_PAUSE');
        if (pause === 'true') {
            console.log('[System] SYSTEM_PAUSE active. Aborting queue consumption.');
            return;
        }

        await consumeHydrationQueue(batch, env);
    }
};
