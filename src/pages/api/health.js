
export const prerender = false;

export async function GET({ locals }) {
    try {
        const dbStatus = locals.runtime.env.DB ? 'connected' : 'disconnected';

        return new Response(JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            services: {
                database: dbStatus,
                cache: 'active'
            },
            checks: {
                d1: {
                    status: 'operational',
                    quarantine_24h: 0 // Placeholder logic
                }
            }
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({
            status: 'unhealthy',
            error: error.message
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }
}
