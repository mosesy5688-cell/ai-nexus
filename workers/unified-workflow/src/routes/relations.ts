import { Env } from '../config/types';

/**
 * Handle /api/relations/ requests
 */
export async function handleRelations(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);
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

    return new Response(JSON.stringify({ error: 'Invalid relation request' }), { status: 400 });
}
