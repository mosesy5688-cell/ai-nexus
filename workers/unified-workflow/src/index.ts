
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Env, WorkflowResult } from './config/types';
import { runIngestionStep } from './steps/ingestion';
import { runFNIStep } from './steps/fni';
import { logExecution } from './steps/monitor';
import { runPrecomputeStep } from './steps/precompute';
import { consumeHydrationQueue } from './consumers/hydration';
import { consumeIngestionQueue } from './consumers/ingestion';  // V7.1

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

        // Route: API Search - Server-side FTS search (B.17)
        if (path.startsWith('api/search')) {
            const query = url.searchParams.get('q');
            const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

            if (!query) {
                return new Response(JSON.stringify({ error: 'Query parameter "q" is required' }), { status: 400 });
            }

            try {
                // Using FTS5 MATCH with JOIN for ranking by fni_score
                const results = await env.DB.prepare(`
                    SELECT 
                        e.id, e.name, e.author, e.type, 
                        e.primary_category, e.fni_score, e.likes, e.downloads
                    FROM entities e
                    JOIN entities_fts f ON e.id = f.id
                    WHERE entities_fts MATCH ?
                    ORDER BY e.fni_score DESC
                    LIMIT ?
                `).bind(query, limit).all();

                return new Response(JSON.stringify({
                    query,
                    results: results.results || [],
                    count: results.results?.length || 0,
                    timestamp: new Date().toISOString()
                }), {
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'public, max-age=600', // 10 min cache
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500 });
            }
        }

        // Route: API Relations - Query entity relations from D1
        if (path.startsWith('api/relations/')) {
            const entityId = decodeURIComponent(path.replace('api/relations/', ''));

            // GET /api/relations/:entityId - Query relations for an entity
            if (entityId && entityId !== 'sync') {
                try {
                    const relations = await env.DB.prepare(
                        `SELECT * FROM entity_relations 
                         WHERE source_id = ? OR target_id = ?
                         ORDER BY confidence DESC
                         LIMIT 100`
                    ).bind(entityId, entityId).all();

                    return new Response(JSON.stringify({
                        entity_id: entityId,
                        relations: relations.results || [],
                        count: relations.results?.length || 0
                    }), {
                        headers: {
                            'Content-Type': 'application/json',
                            'Cache-Control': 'public, max-age=3600',
                            'Access-Control-Allow-Origin': '*'
                        }
                    });
                } catch (e: any) {
                    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
                }
            }

            // POST /api/relations/sync - Sync relations from R2 to D1
            if (entityId === 'sync' && request.method === 'POST') {
                try {
                    const relationsFile = await env.R2_ASSETS.get('computed/relations.json');
                    if (!relationsFile) {
                        return new Response(JSON.stringify({ error: 'Relations file not found in R2' }), { status: 404 });
                    }

                    const relations = await relationsFile.json() as any[];
                    let inserted = 0;
                    const BATCH_SIZE = 100;

                    // Batch UPSERT to D1
                    for (let i = 0; i < relations.length; i += BATCH_SIZE) {
                        const batch = relations.slice(i, i + BATCH_SIZE);
                        const stmt = env.DB.prepare(
                            `INSERT OR REPLACE INTO entity_relations 
                             (source_id, target_id, relation_type, confidence, source_url)
                             VALUES (?, ?, ?, ?, ?)`
                        );

                        const batchStmts = batch.map((r: any) =>
                            stmt.bind(r.source_id, r.target_id, r.relation_type, r.confidence || 1.0, r.source_url || null)
                        );

                        await env.DB.batch(batchStmts);
                        inserted += batch.length;
                    }

                    return new Response(JSON.stringify({
                        status: 'success',
                        synced: inserted,
                        timestamp: new Date().toISOString()
                    }), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                } catch (e: any) {
                    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
                }
            }
        }

        if (url.pathname === '/trigger') {
            await env.UNIFIED_WORKFLOW.create();
            return new Response('Triggered');
        }
        return new Response('Unified Workflow V6.0 (Orchestrator)\nEndpoints: /trigger, /api/relations/, /sitemap*.xml');
    },

    async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
        if (env.KV) {
            const pause = await env.KV.get('SYSTEM_PAUSE');
            if (pause === 'true') {
                console.log('[System] SYSTEM_PAUSE active. Aborting scheduled run.');
                return;
            }
        }

        console.log('[Cron] Triggering workflow...');
        await env.UNIFIED_WORKFLOW.create();
    },

    async queue(batch: any, env: Env): Promise<void> {
        if (env.KV) {
            const pause = await env.KV.get('SYSTEM_PAUSE');
            if (pause === 'true') {
                console.log('[System] SYSTEM_PAUSE active. Aborting queue consumption.');
                return;
            }
        }

        // V7.1: Route to appropriate consumer based on queue
        const queueName = batch.queue;
        if (queueName === 'ai-nexus-ingestion-queue') {
            await consumeIngestionQueue(batch, env);
        } else {
            await consumeHydrationQueue(batch, env);
        }
    }
};
