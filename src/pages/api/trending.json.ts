/**
 * Trending API Endpoint
 * 
 * Constitution V4.1 Compliance:
 * - Pillar VII: Fair Index - Quality gates (FNI >= 30, downloads > 100)
 * - Pillar VIII: Cloud-Native - D1 queries via Cloudflare runtime
 * - Caching Strategy: D1 + CF Edge Cache (max-age=600)
 * 
 * Cold Start Fallback:
 * - Strategy A: Real Velocity (fni_v > 0) - The ideal trending models
 * - Strategy B: High Quality New Arrivals (fni_score >= 40) - Day 0 fallback
 */

import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
    try {
        const db = locals.runtime?.env?.DB;

        if (!db) {
            console.log('[Trending API] D1 not available - returning empty array');
            return new Response(JSON.stringify([]), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=60' // Short cache when no DB
                }
            });
        }

        // Strategy A: Real Velocity (The Ideal)
        // Quality Gate: FNI >= 30, Downloads > 100, Velocity > 0
        const velocityQuery = `
      SELECT * FROM models 
      WHERE fni_v > 0 AND fni_score >= 30 AND downloads > 100
      ORDER BY fni_v DESC 
      LIMIT 8
    `;

        let { results } = await db.prepare(velocityQuery).all();

        // Strategy B: Cold Start Fallback (The Backup)
        // If we have no velocity data yet (Day 0), show "High Quality New Arrivals"
        if (!results || results.length < 4) {
            console.log('[Trending API] Cold Start Fallback triggered - using High Quality New Arrivals');

            const fallbackQuery = `
        SELECT * FROM models 
        WHERE fni_score >= 40 
        ORDER BY last_updated DESC 
        LIMIT 8
      `;

            const fallback = await db.prepare(fallbackQuery).all();
            results = fallback.results || [];
        }

        // Strategy C: Absolute Fallback (Emergency)
        // If even fallback returns nothing, get any models sorted by downloads
        if (!results || results.length === 0) {
            console.log('[Trending API] Absolute Fallback - using top downloads');

            const emergencyQuery = `
        SELECT * FROM models 
        ORDER BY downloads DESC 
        LIMIT 8
      `;

            const emergency = await db.prepare(emergencyQuery).all();
            results = emergency.results || [];
        }

        console.log(`[Trending API] Returning ${results.length} models`);

        return new Response(JSON.stringify(results), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=600' // Cache for 10 mins per V4.1
            }
        });

    } catch (err) {
        console.error('[Trending API] Error:', err);
        return new Response(JSON.stringify({
            error: err instanceof Error ? err.message : 'Unknown error',
            fallback: true
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
};
