// API endpoint to test DB connection and data structure
export const prerender = false;
export async function GET({ locals, request }) {
    try {
        const db = locals?.runtime?.env?.DB;
        const url = new URL(request.url);
        const debugSlug = url.searchParams.get('slug'); // e.g. ollama--ollama

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

        let result = {};

        if (debugSlug) {
            // Debug specific model logic
            const modelId = debugSlug.replace(/--/g, '/');
            const firstSlashIndex = modelId.indexOf('/');
            let model = null;

            if (firstSlashIndex !== -1) {
                const author = modelId.substring(0, firstSlashIndex);
                const name = modelId.substring(firstSlashIndex + 1);
                model = await db.prepare('SELECT * FROM models WHERE author = ? AND name = ?').bind(author, name).first();
            }

            if (!model) {
                model = await db.prepare('SELECT * FROM models WHERE id = ?').bind(modelId).first();
            }

            result.model = model;

            if (model) {
                // Test Fallback Query
                const fallbackStmt = db.prepare(`
                    SELECT id, name, author, likes, downloads, pipeline_tag 
                    FROM models 
                    WHERE pipeline_tag = ? AND id != ?
                    ORDER BY downloads DESC 
                    LIMIT 6
                `);
                const { results } = await fallbackStmt.bind(model.pipeline_tag, model.id).all();
                result.fallbackResults = results;
            }
        } else {
            // Default test
            const testQuery = await db.prepare(`SELECT * FROM models LIMIT 1`).first();
            result.testQueryResult = testQuery;
        }

        return new Response(JSON.stringify({
            success: true,
            dbConnected: true,
            ...result
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
