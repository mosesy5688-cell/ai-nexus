/**
 * R2-First Lakehouse: D1 Ingest API
 * 
 * This endpoint receives JSON batch files from R2 and writes them to D1
 * using parameterized queries (db.batch with prepared statements).
 * 
 * Benefits:
 * 1. Bypasses D1 SQL parsing limits (no raw SQL text)
 * 2. Internal CF network (R2 → Worker → D1)
 * 3. 10x faster than wrangler d1 execute
 * 
 * @security Protected by X-Admin-Key header
 */

export async function POST({ request, locals }) {
    // 1. Authentication
    const adminKey = request.headers.get('X-Admin-Key');
    const expectedKey = locals.runtime?.env?.ADMIN_SECRET || import.meta.env.ADMIN_SECRET;

    if (!adminKey || adminKey !== expectedKey) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const { filename } = await request.json();

        if (!filename) {
            return new Response(JSON.stringify({ error: 'Missing filename parameter' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 2. Get bindings
        const r2 = locals.runtime?.env?.R2_ASSETS;
        const db = locals.runtime?.env?.DB;

        if (!r2 || !db) {
            return new Response(JSON.stringify({ error: 'Missing R2 or D1 bindings' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 3. Fetch JSON from R2 (internal network - fast)
        const file = await r2.get(`ingest/${filename}`);

        if (!file) {
            return new Response(JSON.stringify({ error: `File not found: ingest/${filename}` }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const models = await file.json();

        if (!Array.isArray(models) || models.length === 0) {
            return new Response(JSON.stringify({ error: 'Invalid or empty JSON array' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 4. Build parameterized statements for D1 batch
        const stmts = models.map(m => {
            return db.prepare(`
                INSERT OR REPLACE INTO models (
                    id, slug, name, author, description, tags, pipeline_tag,
                    likes, downloads, cover_image_url, source_trail, commercial_slots,
                    notebooklm_summary, velocity_score, last_commercial_at, type,
                    body_content, body_content_url, meta_json, assets_json, relations_json,
                    canonical_id, license_spdx, compliance_status, quality_score,
                    content_hash, velocity, raw_image_url, last_updated
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).bind(
                m.id,
                m.slug,
                m.name,
                m.author,
                m.description,
                m.tags,
                m.pipeline_tag,
                m.likes,
                m.downloads,
                m.cover_image_url || null,
                m.source_trail || null,
                m.commercial_slots || null,
                m.notebooklm_summary || null,
                m.velocity_score || null,
                m.last_commercial_at || null,
                m.entity_type,
                m.search_text || null,  // body_content column stores search_text
                m.body_content_url || null,
                m.meta_json || null,
                m.assets_json || null,
                m.relations_json || null,
                m.canonical_id || null,
                m.license_spdx || null,
                m.compliance_status,
                m.quality_score || null,
                m.content_hash || null,
                m.velocity || null,
                m.raw_image_url || null
            );
        });

        // 5. Execute batch (atomic, fast)
        await db.batch(stmts);

        // 6. Archive: Move to processed/ directory
        const timestamp = new Date().toISOString().split('T')[0];
        const processedPath = `ingest/processed/${timestamp}/${filename}`;

        // Copy to processed
        await r2.put(processedPath, await file.arrayBuffer());

        // Delete original
        await r2.delete(`ingest/${filename}`);

        return new Response(JSON.stringify({
            success: true,
            processed: models.length,
            archived: processedPath
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Ingest API error:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// Health check
export async function GET() {
    return new Response(JSON.stringify({
        status: 'ok',
        endpoint: 'R2-First Lakehouse Ingest API',
        version: '1.0.0'
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}
