import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

/**
 * V4.1 Unified Workflow - Single Cron, Multiple Tasks
 * 
 * FIXED: Step callbacks now perform I/O directly in run() scope
 * to avoid 'this' context loss during step serialization.
 */

interface Env {
    DB: D1Database;
    R2_ASSETS: R2Bucket;
    UNIFIED_WORKFLOW: Workflow;
}

interface WorkflowResult {
    status: string;
    ingest?: { filesProcessed: number; modelsIngested: number };
    fni?: { modelsCalculated: number; mode: string };
    duration_ms: number;
}

// ============================================================
// UNIFIED WORKFLOW CLASS
// ============================================================

export class UnifiedWorkflow extends WorkflowEntrypoint<Env> {

    async run(event: WorkflowEvent<{}>, step: WorkflowStep): Promise<WorkflowResult> {
        const startTime = Date.now();
        let result: WorkflowResult = { status: 'completed', duration_ms: 0 };

        // Capture env at the class level - this.env should work in the run scope
        const env = this.env;

        // ---------------------------------------------------------
        // STEP 1: INGEST (High Frequency)
        // ---------------------------------------------------------
        const ingestResult = await step.do('ingest-raw-data', async () => {
            console.log('[Ingest] Starting ingestion...');

            // List pending files in raw-data/
            console.log('[Ingest] Listing files in raw-data/...');
            const listed = await env.R2_ASSETS.list({
                prefix: 'raw-data/',
                limit: 100
            });

            console.log(`[Ingest] R2 list returned: ${listed.objects.length} total objects, truncated: ${listed.truncated}`);

            // Debug: log all object keys
            if (listed.objects.length > 0) {
                console.log('[Ingest] Objects found:', listed.objects.map(o => o.key).join(', '));
            }

            const jsonFiles = listed.objects.filter(obj => obj.key.endsWith('.json'));
            console.log(`[Ingest] JSON files after filter: ${jsonFiles.length}`);

            if (jsonFiles.length === 0) {
                console.log('[Ingest] No pending files in raw-data/');
                return { filesProcessed: 0, modelsIngested: 0 };
            }

            console.log(`[Ingest] Found ${jsonFiles.length} files to process`);

            // V4.1 HUNGRY MODE: Process up to 20 files per run (was 1)
            const MAX_FILES_PER_RUN = 20;
            let totalModels = 0;
            let filesProcessed = 0;

            for (const fileObj of jsonFiles.slice(0, MAX_FILES_PER_RUN)) { // Process up to 20 files per run
                try {
                    console.log(`[Ingest] Fetching ${fileObj.key}...`);
                    const file = await env.R2_ASSETS.get(fileObj.key);
                    if (!file) {
                        console.log(`[Ingest] File not found: ${fileObj.key}`);
                        continue;
                    }

                    const models = await file.json() as any[];
                    console.log(`[Ingest] Processing ${fileObj.key}: ${models.length} models`);

                    // Clean and prepare models
                    const cleanedModels = models.map(m => cleanModel(m));

                    // L2 VALIDATION: Separate valid from invalid models (Art.Shadow)
                    const validModels: any[] = [];
                    const invalidModels: { model: any; validation: ValidationResult }[] = [];

                    for (const m of cleanedModels) {
                        const validation = validateModel(m);
                        if (validation.valid) {
                            validModels.push(m);
                        } else {
                            invalidModels.push({ model: m, validation });
                        }
                    }

                    console.log(`[Ingest] Validation: ${validModels.length} valid, ${invalidModels.length} invalid`);

                    // Route invalid models to Shadow DB
                    for (const { model, validation } of invalidModels) {
                        await routeToShadowDB(env.DB, model, validation);
                    }

                    // Write valid models to D1 in batches
                    for (let i = 0; i < validModels.length; i += 50) {
                        const batch = validModels.slice(i, i + 50);
                        const stmts = batch.map(m =>
                            env.DB.prepare(`
                                INSERT OR REPLACE INTO models (
                                    id, slug, name, author, description, tags,
                                    likes, downloads, cover_image_url, body_content_url,
                                    source_trail, license_spdx, has_ollama, has_gguf,
                                    last_updated
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `).bind(
                                m.id, m.slug, m.name, m.author, m.description, m.tags,
                                m.likes, m.downloads, m.cover_image_url, m.body_content_url,
                                m.source_trail, m.license_spdx, m.has_ollama, m.has_gguf,
                                m.last_updated
                            )
                        );
                        await env.DB.batch(stmts);
                        console.log(`[Ingest] Wrote batch ${Math.floor(i / 50) + 1}: ${batch.length} models`);
                    }

                    totalModels += cleanedModels.length;
                    filesProcessed++;

                    // Archive processed file
                    const archiveFile = await env.R2_ASSETS.get(fileObj.key);
                    if (archiveFile) {
                        const today = new Date().toISOString().split('T')[0];
                        const archiveKey = `processed/${today}/${fileObj.key.split('/').pop()}`;
                        await env.R2_ASSETS.put(archiveKey, archiveFile.body);
                        await env.R2_ASSETS.delete(fileObj.key);
                        console.log(`[Ingest] Archived: ${fileObj.key} -> ${archiveKey}`);
                    }
                } catch (error) {
                    console.error(`[Ingest] Error processing ${fileObj.key}:`, error);
                }
            }

            return { filesProcessed, modelsIngested: totalModels };
        });
        result.ingest = ingestResult;

        // ---------------------------------------------------------
        // STEP 2: FNI CALCULATION (Smart Schedule)
        // ---------------------------------------------------------
        const fniResult = await step.do('calculate-fni', async () => {
            const hour = new Date().getUTCHours();
            const isFullRecalc = hour === 4;
            const mode = isFullRecalc ? 'full' : 'incremental';

            console.log(`[FNI] Running ${mode.toUpperCase()} calculation (hour=${hour})`);

            // On full recalc, take a daily snapshot first
            if (isFullRecalc) {
                console.log('[FNI] Taking daily snapshot for Velocity tracking...');
                await env.DB.prepare(`
                    INSERT INTO models_history (model_id, downloads, likes)
                    SELECT id, downloads, likes FROM models
                `).run();
                console.log('[FNI] Snapshot complete');
            }

            const query = isFullRecalc
                ? `SELECT id, downloads, likes, license_spdx, body_content_url, 
                   source_trail, has_ollama, has_gguf FROM models`
                : `SELECT id, downloads, likes, license_spdx, body_content_url, 
                   source_trail, has_ollama, has_gguf FROM models 
                   WHERE last_updated > datetime('now', '-1 day')`;

            const models = await env.DB.prepare(query).all();

            if (!models.results || models.results.length === 0) {
                console.log('[FNI] No models to update');
                return { modelsCalculated: 0, mode };
            }

            // Fetch historical data for velocity calculation
            const historyMap = new Map<string, { downloads: number; likes: number }>();
            if (isFullRecalc) {
                const history = await env.DB.prepare(`
                    SELECT model_id, downloads, likes 
                    FROM models_history 
                    WHERE recorded_at < datetime('now', '-6 days')
                    AND recorded_at > datetime('now', '-8 days')
                `).all();
                for (const h of (history.results || []) as any[]) {
                    historyMap.set(h.model_id, { downloads: h.downloads || 0, likes: h.likes || 0 });
                }
                console.log(`[FNI] Found ${historyMap.size} models with 7-day history`);
            }

            const updates = models.results.map((m: any) => {
                const oldData = historyMap.get(m.id);
                const fni = computeFNI(m, oldData);
                return env.DB.prepare(`
                    UPDATE models SET 
                        fni_score = ?, fni_p = ?, fni_v = ?, fni_c = ?, fni_u = ?
                    WHERE id = ?
                `).bind(fni.score, fni.p, fni.v, fni.c, fni.u, m.id);
            });

            // Batch update in chunks of 50
            for (let i = 0; i < updates.length; i += 50) {
                const chunk = updates.slice(i, i + 50);
                await env.DB.batch(chunk);
            }

            console.log(`[FNI] ${mode} calculation completed: ${models.results.length} models`);
            return { modelsCalculated: models.results.length, mode };
        });
        result.fni = fniResult;

        // ---------------------------------------------------------
        // STEP 3: MONITORING
        // ---------------------------------------------------------
        result.duration_ms = Date.now() - startTime;
        await step.do('log-execution', async () => {
            const safeWorkflowId = event.id || 'unknown';
            const safeStatus = result?.status || 'completed';
            const safeIngestCount = result?.ingest?.modelsIngested ?? 0;
            const safeFniCount = result?.fni?.modelsCalculated ?? 0;
            const safeDurationMs = result?.duration_ms ?? 0;

            console.log(`[Monitor] Logging: workflowId=${safeWorkflowId}, ingest=${safeIngestCount}, fni=${safeFniCount}`);

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
        });

        // ---------------------------------------------------------
        // STEP 4: L8 PRECOMPUTE (Every 6 hours)
        // Generate cache files for read-only frontend
        // ---------------------------------------------------------
        const hour = new Date().getUTCHours();
        if (hour % 6 === 0) { // Run at 0, 6, 12, 18 UTC
            await step.do('precompute-cache', async () => {
                console.log('[L8] Starting cache precompute...');

                // Trending models (top 100 by FNI)
                const trending = await env.DB.prepare(`
                    SELECT id, slug, name, author, fni_score, downloads, likes,
                           cover_image_url, tags, has_ollama, has_gguf
                    FROM models 
                    WHERE fni_score IS NOT NULL
                    ORDER BY fni_score DESC 
                    LIMIT 100
                `).all();

                if (trending.results && trending.results.length > 0) {
                    await env.R2_ASSETS.put('cache/trending.json',
                        JSON.stringify({
                            generated_at: new Date().toISOString(),
                            version: 'V4.7',
                            count: trending.results.length,
                            models: trending.results
                        }, null, 2),
                        { httpMetadata: { contentType: 'application/json' } }
                    );
                    console.log(`[L8] Trending cache: ${trending.results.length} models`);
                }

                // Leaderboard (top 50 with benchmarks)
                const leaderboard = await env.DB.prepare(`
                    SELECT m.id, m.slug, m.name, m.author, m.fni_score,
                           m.deploy_score, m.architecture_family, m.has_ollama
                    FROM models m
                    WHERE m.fni_score IS NOT NULL
                    ORDER BY m.fni_score DESC
                    LIMIT 50
                `).all();

                if (leaderboard.results && leaderboard.results.length > 0) {
                    await env.R2_ASSETS.put('cache/leaderboard.json',
                        JSON.stringify({
                            generated_at: new Date().toISOString(),
                            version: 'V4.7',
                            count: leaderboard.results.length,
                            models: leaderboard.results
                        }, null, 2),
                        { httpMetadata: { contentType: 'application/json' } }
                    );
                    console.log(`[L8] Leaderboard cache: ${leaderboard.results.length} models`);
                }

                console.log('[L8] Cache precompute complete');

                // ---------------------------------------------------------
                // L8 EXTENSION: Entity Links (V4.8.1)
                // Derive model relationships from architecture_family
                // ---------------------------------------------------------
                console.log('[L8] Generating entity links...');

                // Get models with architecture info
                const modelsWithArch = await env.DB.prepare(`
                    SELECT id, slug, name, author, architecture_family, deploy_score,
                           tags, description
                    FROM models 
                    WHERE id IS NOT NULL
                    LIMIT 500
                `).all();

                if (modelsWithArch.results && modelsWithArch.results.length > 0) {
                    // Clear existing entity_links
                    await env.DB.prepare('DELETE FROM entity_links WHERE 1=1').run();

                    let linksCreated = 0;
                    const models = modelsWithArch.results as any[];

                    // Create links based on architecture_type and author
                    for (const model of models) {
                        // Find siblings (same author, different model)
                        const siblings = models.filter(m =>
                            m.author === model.author &&
                            m.id !== model.id
                        ).slice(0, 5);

                        for (const sibling of siblings) {
                            await env.DB.prepare(`
                                INSERT OR IGNORE INTO entity_links 
                                (source_id, target_id, link_type, confidence, created_at)
                                VALUES (?, ?, 'sibling', 0.8, datetime('now'))
                            `).bind(model.id, sibling.id).run();
                            linksCreated++;
                        }

                        // Find same architecture models
                        if (model.architecture_family) {
                            const sameArch = models.filter(m =>
                                m.architecture_family === model.architecture_family &&
                                m.id !== model.id
                            ).slice(0, 3);

                            for (const related of sameArch) {
                                await env.DB.prepare(`
                                    INSERT OR IGNORE INTO entity_links 
                                    (source_id, target_id, link_type, confidence, created_at)
                                    VALUES (?, ?, 'same_architecture', 0.7, datetime('now'))
                                `).bind(model.id, related.id).run();
                                linksCreated++;
                            }
                        }
                    }

                    console.log(`[L8] Entity links created: ${linksCreated}`);
                }

                // ---------------------------------------------------------
                // L8 EXTENSION: Neural Graph (V4.8.1 Art.11-G)
                // Version-locked static graph for Neural Explorer
                // ---------------------------------------------------------
                console.log('[L8] Generating neural graph...');

                const graphNodes = await env.DB.prepare(`
                    SELECT id, slug, name, author, architecture_family, 
                           deploy_score, fni_score, has_ollama
                    FROM models 
                    WHERE fni_score IS NOT NULL
                    ORDER BY fni_score DESC
                    LIMIT 200
                `).all();

                const graphLinks = await env.DB.prepare(`
                    SELECT source_id, target_id, link_type, confidence
                    FROM entity_links
                    LIMIT 1000
                `).all();

                const graphVersion = new Date().toISOString().split('T')[0];
                const neuralGraph = {
                    version: graphVersion,
                    generated_at: new Date().toISOString(),
                    schema: 'V4.8.2',
                    nodes: (graphNodes.results || []).map((m: any) => ({
                        id: m.id,
                        slug: m.slug,
                        name: m.name,
                        author: m.author,
                        arch: m.architecture_family || 'unknown',
                        deployScore: m.deploy_score || 0,
                        fni: m.fni_score || 0,
                        local: m.has_ollama === 1
                    })),
                    links: (graphLinks.results || []).map((l: any) => ({
                        source: l.source_id,
                        target: l.target_id,
                        type: l.link_type,
                        weight: l.confidence
                    }))
                };

                await env.R2_ASSETS.put('cache/neural_graph.json',
                    JSON.stringify(neuralGraph, null, 2),
                    { httpMetadata: { contentType: 'application/json' } }
                );

                console.log(`[L8] Neural graph: ${neuralGraph.nodes.length} nodes, ${neuralGraph.links.length} links`);

                // ---------------------------------------------------------
                // L8 EXTENSION: Category Stats (V4.8.1)
                // Generate per-category model counts and avg FNI for homepage
                // ---------------------------------------------------------
                console.log('[L8] Generating category stats...');

                const categoryStats = await env.DB.prepare(`
                    SELECT 
                        pipeline_tag as category,
                        COUNT(*) as model_count,
                        AVG(fni_score) as avg_fni,
                        MAX(fni_score) as top_fni
                    FROM models 
                    WHERE pipeline_tag IS NOT NULL AND pipeline_tag != ''
                    GROUP BY pipeline_tag
                    ORDER BY model_count DESC
                    LIMIT 50
                `).all();

                // Also get tag-based stats (for custom categories)
                const tagStats = await env.DB.prepare(`
                    SELECT 
                        tags,
                        COUNT(*) as model_count,
                        AVG(fni_score) as avg_fni
                    FROM models 
                    WHERE tags IS NOT NULL
                    GROUP BY tags
                    LIMIT 100
                `).all();

                const categoryData = {
                    generated_at: new Date().toISOString(),
                    version: 'V4.8.2',
                    pipeline_tags: (categoryStats.results || []).map((c: any) => ({
                        category: c.category,
                        count: c.model_count,
                        avgFni: c.avg_fni ? Math.round(c.avg_fni * 10) / 10 : null,
                        topFni: c.top_fni ? Math.round(c.top_fni * 10) / 10 : null
                    })),
                    total_categories: (categoryStats.results || []).length
                };

                await env.R2_ASSETS.put('cache/category_stats.json',
                    JSON.stringify(categoryData, null, 2),
                    { httpMetadata: { contentType: 'application/json' } }
                );

                console.log(`[L8] Category stats: ${categoryData.total_categories} categories`);

                // ---------------------------------------------------------
                // L8 EXTENSION: Benchmarks Cache (V4.8.1)
                // Generate benchmarks.json for BenchmarkRawTable component
                // Constitutional: L8 = Frontend Single Source
                // ---------------------------------------------------------
                console.log('[L8] Generating benchmarks cache...');

                const benchmarks = await env.DB.prepare(`
                    SELECT 
                        id as umid, slug, name, author,
                        fni_score, pwc_benchmarks
                    FROM models 
                    WHERE fni_score IS NOT NULL
                    ORDER BY fni_score DESC
                    LIMIT 500
                `).all();

                const benchmarkData = {
                    generated_at: new Date().toISOString(),
                    version: 'V4.8.2',
                    data: (benchmarks.results || []).map((m: any) => {
                        // Parse pwc_benchmarks JSON if available
                        let parsed: any = {};
                        try {
                            if (m.pwc_benchmarks) {
                                parsed = JSON.parse(m.pwc_benchmarks);
                            }
                        } catch { }

                        return {
                            umid: m.umid,
                            slug: m.slug,
                            name: m.name,
                            author: m.author,
                            fni_score: m.fni_score,
                            mmlu: parsed.mmlu || null,
                            humaneval: parsed.humaneval || null,
                            hellaswag: parsed.hellaswag || null,
                            arc_challenge: parsed.arc_challenge || null,
                            avg_score: parsed.avg_score || m.fni_score,
                            quality_flag: 'ok'
                        };
                    })
                };

                await env.R2_ASSETS.put('cache/benchmarks.json',
                    JSON.stringify(benchmarkData, null, 2),
                    { httpMetadata: { contentType: 'application/json' } }
                );

                console.log(`[L8] Benchmarks cache: ${benchmarkData.data.length} models`);

                // ---------------------------------------------------------
                // L8 EXTENSION: Entity Links Cache (V4.8.2)
                // Pre-computed model relationships for EntityLinksSection
                // Constitutional: Frontend D1 = 0, must use R2 cache
                // ---------------------------------------------------------
                console.log('[L8] Generating entity links cache...');

                const entityLinksResult = await env.DB.prepare(`
                    SELECT 
                        el.source_id, el.target_id, el.link_type, el.confidence,
                        m.name as target_name, m.slug as target_slug
                    FROM entity_links el
                    JOIN models m ON el.target_id = m.id
                    ORDER BY el.confidence DESC
                    LIMIT 2000
                `).all();

                // Group links by source_id for efficient frontend lookup
                const linksByModel: Record<string, any[]> = {};
                for (const link of (entityLinksResult.results || []) as any[]) {
                    if (!linksByModel[link.source_id]) {
                        linksByModel[link.source_id] = [];
                    }
                    linksByModel[link.source_id].push({
                        target_id: link.target_id,
                        target_name: link.target_name || 'Unknown',
                        target_slug: link.target_slug || '',
                        link_type: link.link_type,
                        confidence: link.confidence
                    });
                }

                const entityLinksCache = {
                    generated_at: new Date().toISOString(),
                    version: 'V4.8.2',
                    schema_version: 'V4.8.2',
                    frontend_contract_version: 'V4.8.2',
                    total_links: (entityLinksResult.results || []).length,
                    models_with_links: Object.keys(linksByModel).length,
                    links: linksByModel
                };

                await env.R2_ASSETS.put('cache/entity_links.json',
                    JSON.stringify(entityLinksCache, null, 2),
                    { httpMetadata: { contentType: 'application/json' } }
                );

                console.log(`[L8] Entity links cache: ${entityLinksCache.total_links} links for ${entityLinksCache.models_with_links} models`);

                // ---------------------------------------------------------
                // L8 EXTENSION: Entity Definitions (V4.9)
                // Pre-computed entity type definitions for frontend
                // Constitutional: Art.IX-Batch - Entity definitions in R2
                // ---------------------------------------------------------
                console.log('[L8] Generating entity definitions cache...');

                const entityDefinitions = {
                    generated_at: new Date().toISOString(),
                    version: 'V4.9',
                    schema_version: 'entity.v1',
                    types: {
                        model: {
                            type: 'model',
                            idPrefix: 'hf-model--',
                            seoType: 'SoftwareApplication',
                            tier: 'core',
                            capabilities: ['fni', 'deploy', 'benchmark', 'architecture', 'ollama', 'gguf'],
                            display: { icon: '🧠', color: 'blue', labelSingular: 'Model', labelPlural: 'Models' }
                        },
                        dataset: {
                            type: 'dataset',
                            idPrefix: 'hf-dataset--',
                            seoType: 'Dataset',
                            tier: 'enablers',
                            capabilities: ['citations', 'size'],
                            display: { icon: '📊', color: 'green', labelSingular: 'Dataset', labelPlural: 'Datasets' }
                        },
                        benchmark: {
                            type: 'benchmark',
                            idPrefix: 'benchmark--',
                            seoType: 'Dataset',
                            tier: 'enablers',
                            capabilities: ['benchmark', 'citations'],
                            display: { icon: '🏆', color: 'orange', labelSingular: 'Benchmark', labelPlural: 'Benchmarks' }
                        },
                        paper: {
                            type: 'paper',
                            idPrefix: 'arxiv--',
                            seoType: 'ScholarlyArticle',
                            tier: 'knowledge',
                            capabilities: ['citations'],
                            display: { icon: '📄', color: 'yellow', labelSingular: 'Paper', labelPlural: 'Papers' }
                        },
                        agent: {
                            type: 'agent',
                            idPrefix: 'agent--',
                            seoType: 'SoftwareApplication',
                            tier: 'ecosystem',
                            capabilities: ['deploy', 'architecture', 'integrations', 'pricing'],
                            display: { icon: '🤖', color: 'pink', labelSingular: 'Agent', labelPlural: 'Agents' }
                        }
                    }
                };

                await env.R2_ASSETS.put('cache/entity_definitions.json',
                    JSON.stringify(entityDefinitions, null, 2),
                    { httpMetadata: { contentType: 'application/json' } }
                );

                console.log(`[L8] Entity definitions cache: ${Object.keys(entityDefinitions.types).length} types`);

                // ---------------------------------------------------------
                // L8 EXTENSION: Segregated Trending Lists (V4.9)
                // Art.X-Entity-List: Lists segregated by entity type
                // ---------------------------------------------------------
                console.log('[L8] Generating segregated trending lists...');

                // Trending models (with FNI)
                const trendingModels = await env.DB.prepare(`
                    SELECT 
                        id, slug, name, author, fni_score, deploy_score,
                        downloads, likes, pipeline_tag, architecture_family
                    FROM models 
                    WHERE fni_score IS NOT NULL
                    ORDER BY fni_score DESC
                    LIMIT 50
                `).all();

                const trendingModelsCache = {
                    generated_at: new Date().toISOString(),
                    version: 'V4.9',
                    entity_type: 'model',
                    data: (trendingModels.results || []).map((m: any) => ({
                        id: m.id,
                        slug: m.slug,
                        name: m.name,
                        author: m.author,
                        entity_type: 'model',
                        fni_score: m.fni_score,
                        deploy_score: m.deploy_score,
                        downloads: m.downloads,
                        likes: m.likes,
                        category: m.pipeline_tag,
                        architecture: m.architecture_family
                    }))
                };

                await env.R2_ASSETS.put('cache/lists/trending_models.json',
                    JSON.stringify(trendingModelsCache, null, 2),
                    { httpMetadata: { contentType: 'application/json' } }
                );

                console.log(`[L8] Trending models: ${trendingModelsCache.data.length} items`);
            });
        }

        // ---------------------------------------------------------
        // STEP 5: WEEKLY REPORT (Monday only)
        // Generate weekly trending report for users
        // ---------------------------------------------------------
        const dayOfWeek = new Date().getUTCDay();
        if (dayOfWeek === 1 && hour >= 0 && hour < 1) { // Monday 00:00-01:00 UTC
            await step.do('generate-weekly-report', async () => {
                console.log('[Report] Generating weekly report...');

                // Get week number
                const now = new Date();
                const startOfYear = new Date(now.getUTCFullYear(), 0, 1);
                const weekNum = Math.ceil((((now.getTime() - startOfYear.getTime()) / 86400000) + startOfYear.getUTCDay() + 1) / 7);
                const reportKey = `reports/${now.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}.json`;

                // Get top trending models
                const trending = await env.DB.prepare(`
                    SELECT id, slug, name, author, fni_score, downloads, likes
                    FROM models 
                    WHERE fni_score IS NOT NULL
                    ORDER BY fni_score DESC 
                    LIMIT 20
                `).all();

                // Get new models this week
                const newModels = await env.DB.prepare(`
                    SELECT id, slug, name, author
                    FROM models 
                    WHERE last_updated > datetime('now', '-7 days')
                    ORDER BY last_updated DESC
                    LIMIT 10
                `).all();

                const report = {
                    generated_at: now.toISOString(),
                    week: `${now.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`,
                    version: 'V4.7',
                    top_trending: trending.results || [],
                    new_models: newModels.results || [],
                    summary: {
                        total_trending: (trending.results || []).length,
                        total_new: (newModels.results || []).length
                    }
                };

                await env.R2_ASSETS.put(reportKey,
                    JSON.stringify(report, null, 2),
                    { httpMetadata: { contentType: 'application/json' } }
                );

                console.log(`[Report] Weekly report saved: ${reportKey}`);
            });
        }

        // ---------------------------------------------------------
        // STEP 6: L7 ARCHIVIST (Art.VII-Schedule)
        // Monthly archival of data >180 days
        // ---------------------------------------------------------
        const archiveNow = new Date();
        const dayOfMonth = archiveNow.getUTCDate();
        const archiveHour = archiveNow.getUTCHours();

        // Run on 1st of each month, between 02:00-03:00 UTC
        if (dayOfMonth === 1 && archiveHour >= 2 && archiveHour < 3) {
            await step.do('l7-archivist', async () => {
                console.log('[L7 Archivist] Starting monthly archive (Art.VII-Schedule)...');

                const archiveDate = archiveNow.toISOString().split('T')[0].substring(0, 7); // YYYY-MM

                // 1. Archive quarantine_log >180 days
                const quarantineData = await env.DB.prepare(`
                    SELECT * FROM quarantine_log 
                    WHERE created_at < datetime('now', '-180 days')
                `).all();

                if (quarantineData.results && quarantineData.results.length > 0) {
                    const archiveKey = `archives/quarantine_log/${archiveDate}.json`;
                    await env.R2_ASSETS.put(archiveKey,
                        JSON.stringify(quarantineData.results, null, 2),
                        { httpMetadata: { contentType: 'application/json' } }
                    );

                    // Delete archived records from D1
                    await env.DB.prepare(`
                        DELETE FROM quarantine_log 
                        WHERE created_at < datetime('now', '-180 days')
                    `).run();

                    console.log(`[L7 Archivist] Archived ${quarantineData.results.length} quarantine records to ${archiveKey}`);
                }

                // 2. Archive affiliate_clicks >180 days
                const clicksData = await env.DB.prepare(`
                    SELECT * FROM affiliate_clicks 
                    WHERE clicked_at < datetime('now', '-180 days')
                `).all();

                if (clicksData.results && clicksData.results.length > 0) {
                    const archiveKey = `archives/affiliate_clicks/${archiveDate}.json`;
                    await env.R2_ASSETS.put(archiveKey,
                        JSON.stringify(clicksData.results, null, 2),
                        { httpMetadata: { contentType: 'application/json' } }
                    );

                    await env.DB.prepare(`
                        DELETE FROM affiliate_clicks 
                        WHERE clicked_at < datetime('now', '-180 days')
                    `).run();

                    console.log(`[L7 Archivist] Archived ${clicksData.results.length} click records to ${archiveKey}`);
                }

                // 3. Archive models_history >365 days
                const historyData = await env.DB.prepare(`
                    SELECT * FROM models_history 
                    WHERE recorded_at < datetime('now', '-365 days')
                `).all();

                if (historyData.results && historyData.results.length > 0) {
                    const archiveKey = `archives/models_history/${archiveDate}.json`;
                    await env.R2_ASSETS.put(archiveKey,
                        JSON.stringify(historyData.results, null, 2),
                        { httpMetadata: { contentType: 'application/json' } }
                    );

                    await env.DB.prepare(`
                        DELETE FROM models_history 
                        WHERE recorded_at < datetime('now', '-365 days')
                    `).run();

                    console.log(`[L7 Archivist] Archived ${historyData.results.length} history records to ${archiveKey}`);
                }

                // 4. Update manifest
                const manifest = {
                    last_archive: archiveNow.toISOString(),
                    archived_tables: ['quarantine_log', 'affiliate_clicks', 'models_history'],
                    version: 'V4.8'
                };
                await env.R2_ASSETS.put('archives/manifest.json',
                    JSON.stringify(manifest, null, 2),
                    { httpMetadata: { contentType: 'application/json' } }
                );

                console.log('[L7 Archivist] Monthly archive complete');
            });
        }

        return result;
    }
}

// ============================================================
// HELPER FUNCTIONS (outside class to avoid 'this' issues)
// ============================================================

function cleanModel(model: any): any {
    const id = model.id || model.modelId || '';
    const slug = id.replace(/\//g, '-');

    const cleanText = (text: string | null): string => {
        if (!text) return '';
        return String(text)
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 2000);
    };

    return {
        id: id,
        slug: slug,
        name: cleanText(model.title || model.name || model.id || ''),
        author: model.author || '',
        description: cleanText(model.description || ''),
        tags: JSON.stringify(model.tags || (model.pipeline_tag ? [model.pipeline_tag] : [])),
        likes: model.popularity || model.likes || 0,
        downloads: model.downloads || 0,
        // V4.1 Fix: Match orchestrator field names
        cover_image_url: model.raw_image_url || model.cover_image_url || '',
        body_content_url: model.body_content_url || '',
        source_trail: typeof model.source_trail === 'string'
            ? model.source_trail
            : JSON.stringify(model.source_trail || { source: 'huggingface', fetched_at: new Date().toISOString() }),
        license_spdx: model.license_spdx || model.license || '',
        has_ollama: model.has_ollama ? 1 : 0,
        has_gguf: model.has_gguf ? 1 : 0,
        last_updated: new Date().toISOString()
    };
}

// ============================================================
// L2 SHADOW DB VALIDATION (Constitution V4.8 Art.Shadow)
// ============================================================

interface ValidationResult {
    valid: boolean;
    errors: string[];
    honeypotTriggers: string[];
}

/**
 * L2 Normalizer: Validate model data per Constitution V4.8
 * - Schema validation
 * - Honeypot detection
 * - Routes invalid data to Shadow DB
 */
function validateModel(model: any): ValidationResult {
    const errors: string[] = [];
    const honeypotTriggers: string[] = [];

    // Schema validation
    if (!model.id || model.id.length === 0) {
        errors.push('missing_id');
    }
    if (!model.slug || model.slug.length === 0) {
        errors.push('missing_slug');
    }
    if (model.id && model.id.length > 500) {
        errors.push('id_too_long');
    }
    if (model.description && model.description.length > 50000) {
        errors.push('description_too_long');
    }

    // Honeypot detection (poison data patterns)
    const honeypotPatterns = [
        { pattern: /<script/i, name: 'xss_script' },
        { pattern: /javascript:/i, name: 'xss_javascript' },
        { pattern: /onclick\s*=/i, name: 'xss_onclick' },
        { pattern: /eval\s*\(/i, name: 'xss_eval' },
        { pattern: /union\s+select/i, name: 'sql_union' },
        { pattern: /drop\s+table/i, name: 'sql_drop' },
        { pattern: /\x00/, name: 'null_byte' }
    ];

    const fieldsToCheck = [model.name, model.description, model.author];
    for (const field of fieldsToCheck) {
        if (!field) continue;
        for (const { pattern, name } of honeypotPatterns) {
            if (pattern.test(field)) {
                honeypotTriggers.push(name);
            }
        }
    }

    return {
        valid: errors.length === 0 && honeypotTriggers.length === 0,
        errors,
        honeypotTriggers
    };
}

/**
 * Route invalid data to Shadow DB (Art.Shadow)
 * Never auto-merges to main DB
 */
async function routeToShadowDB(
    db: D1Database,
    model: any,
    validation: ValidationResult
): Promise<void> {
    try {
        // Insert into models_shadow
        await db.prepare(`
            INSERT OR REPLACE INTO models_shadow 
            (id, raw_data, validation_errors, honeypot_triggers, created_at)
            VALUES (?, ?, ?, ?, datetime('now'))
        `).bind(
            model.id || 'unknown',
            JSON.stringify(model),
            JSON.stringify(validation.errors),
            JSON.stringify(validation.honeypotTriggers)
        ).run();

        // Log to quarantine_log
        const reason = validation.honeypotTriggers.length > 0
            ? `honeypot:${validation.honeypotTriggers.join(',')}`
            : `schema:${validation.errors.join(',')}`;

        await db.prepare(`
            INSERT INTO quarantine_log (entity_id, reason, severity, created_at)
            VALUES (?, ?, ?, datetime('now'))
        `).bind(
            model.id || 'unknown',
            reason,
            validation.honeypotTriggers.length > 0 ? 'high' : 'medium'
        ).run();

        console.log(`[L2 Shadow] Routed invalid model to Shadow DB: ${model.id}`);
    } catch (error) {
        console.error(`[L2 Shadow] Error routing to Shadow DB:`, error);
    }
}

/**
 * Compute FNI scores using V4.7 canonical weights
 * FNI = P × 30% + V × 30% + C × 20% + U × 20%
 * 
 * @param model - Current model data
 * @param oldData - Optional 7-day old data for velocity calculation
 */
function computeFNI(
    model: any,
    oldData?: { downloads: number; likes: number }
): { score: number; p: number; v: number; c: number; u: number } {
    // P: Popularity (30%) - based on downloads and likes
    const downloads = model.downloads || 0;
    const likes = model.likes || 0;
    const maxDownloads = 1000000;
    const maxLikes = 500000;
    const p = Math.min(100,
        (Math.min(likes / maxLikes, 1) * 40 + Math.min(downloads / maxDownloads, 1) * 60)
    );

    // V: Velocity (30%) - 7-day growth rate
    let v = 0;
    if (oldData) {
        const downloadGrowth = downloads - (oldData.downloads || 0);
        const likeGrowth = likes - (oldData.likes || 0);
        // Normalize: 100K downloads/week = 100, 10K likes/week = 100
        const downloadVelocity = Math.min(100, (downloadGrowth / 100000) * 100);
        const likeVelocity = Math.min(100, (likeGrowth / 10000) * 100);
        v = Math.max(0, (downloadVelocity * 0.7 + likeVelocity * 0.3));
    }

    // C: Credibility (20%) - documentation, license, source trail
    let c = 0;
    if (model.license_spdx) c += 30;
    if (model.body_content_url) c += 40;
    if (model.source_trail) c += 30;

    // U: Utility (20%) - runtime ecosystem support
    let u = 0;
    if (model.has_ollama) u += 50;
    if (model.has_gguf) u += 50;

    // V4.7 Constitution: P×30% + V×30% + C×20% + U×20%
    const score = (p * 0.30) + (v * 0.30) + (c * 0.20) + (u * 0.20);

    return {
        score: Math.min(100, Math.round(score)),
        p: Math.round(p),
        v: Math.round(v),
        c,
        u
    };
}

// ============================================================
// HTTP & CRON HANDLERS
// ============================================================

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/debug-r2') {
            try {
                console.log('[Debug] Listing R2 raw-data/...');
                const listed = await env.R2_ASSETS.list({
                    prefix: 'raw-data/',
                    limit: 100
                });

                const result = {
                    totalObjects: listed.objects.length,
                    truncated: listed.truncated,
                    objects: listed.objects.map(o => ({
                        key: o.key,
                        size: o.size,
                        uploaded: o.uploaded
                    }))
                };

                return new Response(JSON.stringify(result, null, 2), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (error) {
                return new Response(JSON.stringify({ error: String(error) }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        // Manual trigger endpoint for force flush
        if (url.pathname === '/trigger') {
            try {
                console.log('[Trigger] Manual workflow trigger...');
                const instance = await env.UNIFIED_WORKFLOW.create();
                return new Response(JSON.stringify({
                    status: 'triggered',
                    instanceId: instance.id,
                    message: 'Unified Workflow instance created. Check logs for progress.'
                }, null, 2), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (error) {
                return new Response(JSON.stringify({ error: String(error) }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        return new Response('Unified Workflow V4.1 (Hungry Mode)\n\nEndpoints:\n- /debug-r2 - Debug R2 listing\n- /trigger - Manual workflow trigger', {
            headers: { 'Content-Type': 'text/plain' }
        });
    },

    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        console.log(`[Cron] Triggered at ${new Date().toISOString()}`);
        try {
            const instance = await env.UNIFIED_WORKFLOW.create();
            console.log(`[Cron] Started workflow instance: ${instance.id}`);
        } catch (error) {
            console.error('[Cron] Failed to start workflow:', error);
        }
    }
};
