/**
 * V4.8 Health Dashboard API
 * 
 * Provides system health metrics for monitoring:
 * - D1/KV/R2 usage statistics
 * - Shadow DB counts
 * - Guardian performance (P95)
 * - FNI stability
 * 
 * Constitution V4.8 Compliance: Art.IX-Metrics
 */

export async function GET(context: any) {
    const env = context.locals.runtime.env;
    const startTime = performance.now();

    try {
        const health: any = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: 'V4.8',
            checks: {}
        };

        // 1. D1 Database Health
        try {
            const modelCount = await env.DB.prepare(
                'SELECT COUNT(*) as count FROM models'
            ).first();

            const shadowCount = await env.DB.prepare(
                'SELECT COUNT(*) as count FROM models_shadow'
            ).first();

            const quarantineCount = await env.DB.prepare(
                'SELECT COUNT(*) as count FROM quarantine_log WHERE created_at > datetime("now", "-24 hours")'
            ).first();

            health.checks.d1 = {
                status: 'ok',
                models: modelCount?.count || 0,
                shadow_models: shadowCount?.count || 0,
                quarantine_24h: quarantineCount?.count || 0
            };

            // Art.Shadow health: if shadow > 100/month, warn
            if ((shadowCount?.count || 0) > 100) {
                health.checks.d1.status = 'warn';
                health.checks.d1.warning = 'Shadow DB growth exceeds threshold';
            }
        } catch (e) {
            health.checks.d1 = { status: 'error', message: String(e) };
            health.status = 'degraded';
        }

        // 2. KV Cache Health (Guardian Metrics)
        try {
            // Count recent guardian metrics
            const metricsPrefix = 'metrics:guardian:';
            const metrics = await env.KV_CACHE.list({ prefix: metricsPrefix, limit: 100 });

            let totalTime = 0;
            let count = 0;
            const times: number[] = [];

            for (const key of metrics.keys || []) {
                const value = await env.KV_CACHE.get(key.name);
                if (value) {
                    const time = parseFloat(value);
                    if (!isNaN(time)) {
                        times.push(time);
                        totalTime += time;
                        count++;
                    }
                }
            }

            // Calculate P95
            times.sort((a, b) => a - b);
            const p95Index = Math.floor(times.length * 0.95);
            const p95 = times[p95Index] || 0;

            health.checks.guardian = {
                status: p95 < 5 ? 'ok' : p95 < 10 ? 'warn' : 'error',
                samples: count,
                avg_ms: count > 0 ? (totalTime / count).toFixed(2) : 0,
                p95_ms: p95.toFixed(2)
            };

            if (p95 > 5) {
                health.status = p95 > 10 ? 'degraded' : 'warn';
            }
        } catch (e) {
            health.checks.guardian = { status: 'error', message: String(e) };
        }

        // 3. FNI Stability Check
        try {
            const fniStats = await env.DB.prepare(`
                SELECT 
                    AVG(fni_score) as avg_fni,
                    MIN(fni_score) as min_fni,
                    MAX(fni_score) as max_fni,
                    COUNT(*) as total
                FROM models 
                WHERE fni_score IS NOT NULL
            `).first();

            health.checks.fni = {
                status: 'ok',
                avg: fniStats?.avg_fni?.toFixed(2) || 0,
                min: fniStats?.min_fni?.toFixed(2) || 0,
                max: fniStats?.max_fni?.toFixed(2) || 0,
                models_with_fni: fniStats?.total || 0
            };
        } catch (e) {
            health.checks.fni = { status: 'error', message: String(e) };
        }

        // 4. Response time
        health.response_time_ms = (performance.now() - startTime).toFixed(2);

        return new Response(JSON.stringify(health, null, 2), {
            status: health.status === 'healthy' ? 200 :
                health.status === 'warn' ? 200 : 503,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store',
                'X-Health-Version': 'V4.8'
            }
        });

    } catch (error) {
        return new Response(JSON.stringify({
            status: 'error',
            message: String(error),
            timestamp: new Date().toISOString()
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
