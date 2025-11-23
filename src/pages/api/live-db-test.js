// Force dynamic rendering - no prerendering
export const prerender = false;

export async function GET({ locals }) {
    const timestamp = new Date().toISOString();

    try {
        const db = locals?.runtime?.env?.DB;

        if (!db) {
            return new Response(JSON.stringify({
                error: 'DB binding not available',
                timestamp,
                isPrerendered: false
            }), {
                status: 503,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store, no-cache, must-revalidate'
                }
            });
        }

        // Test actual D1 query
        const result = await db.prepare(`SELECT COUNT(*) as count FROM models`).first();

        return new Response(JSON.stringify({
            success: true,
            dbConnected: true,
            timestamp,
            modelCount: result?.count || 0,
            isPrerendered: false
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            }
        });
    } catch (e) {
        return new Response(JSON.stringify({
            error: e.message,
            timestamp,
            isPrerendered: false
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            }
        });
    }
}
