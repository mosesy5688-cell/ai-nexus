// API endpoint to test DB connection and data structure
export const prerender = false;
export async function GET({ locals }) {
    try {
        const db = locals?.runtime?.env?.DB;

        if (!db) {
            return new Response(JSON.stringify({
                error: 'DB binding not available',
                hasLocals: !!locals,
                hasRuntime: !!locals?.runtime,
                hasEnv: !!locals?.runtime?.env,
                envKeys: locals?.runtime?.env ? Object.keys(locals.runtime.env) : []
            }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Test query: Get first model
        const testQuery = await db.prepare(`SELECT * FROM models LIMIT 1`).first();

        return new Response(JSON.stringify({
            success: true,
            dbConnected: true,
            testQueryResult: {
                hasResult: !!testQuery,
                resultType: typeof testQuery,
                isObject: typeof testQuery === 'object',
                keys: testQuery ? Object.keys(testQuery) : [],
                hasId: !!(testQuery?.id),
                hasName: !!(testQuery?.name),
                sample: testQuery
            }
        }, null, 2), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({
            error: e.message,
            stack: e.stack
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
