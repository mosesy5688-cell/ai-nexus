// src/pages/api/comments/index.js
// Loop 3: Auto-Guard - Comments API with AI Moderation

export const prerender = false;

/**
 * GET /api/comments?model_id=xxx
 * Fetch comments for a model
 */
export async function GET({ request, locals }) {
    const url = new URL(request.url);
    const modelId = url.searchParams.get('model_id');

    if (!modelId) {
        return new Response(JSON.stringify({ error: 'model_id required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const db = locals.runtime?.env?.DB;
    if (!db) {
        return new Response(JSON.stringify({ error: 'Database not available' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const { results } = await db.prepare(`
            SELECT c.*, u.name as user_name, u.reputation_score
            FROM comments c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.model_id = ? AND c.is_hidden = 0 AND c.ai_audit_status != 'unsafe'
            ORDER BY c.created_at DESC
            LIMIT 50
        `).bind(modelId).all();

        return new Response(JSON.stringify({ comments: results }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('[Comments API] Error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * POST /api/comments
 * Create a new comment with AI moderation
 */
export async function POST({ request, locals }) {
    const db = locals.runtime?.env?.DB;
    const ai = locals.runtime?.env?.AI;

    if (!db) {
        return new Response(JSON.stringify({ error: 'Database not available' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const body = await request.json();
        const { model_id, user_id, content } = body;

        if (!model_id || !user_id || !content) {
            return new Response(JSON.stringify({ error: 'model_id, user_id, and content required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // AI Moderation using Workers AI
        let auditStatus = 'safe';
        if (ai) {
            try {
                const moderationResult = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a content moderator. Classify the following comment as "safe" or "unsafe". Unsafe includes spam, hate speech, harassment, or inappropriate content. Reply with only one word: safe or unsafe.'
                        },
                        {
                            role: 'user',
                            content: content
                        }
                    ],
                    max_tokens: 10
                });

                const response = moderationResult.response?.toLowerCase() || 'safe';
                auditStatus = response.includes('unsafe') ? 'unsafe' : 'safe';
                console.log(`[Auto-Guard] Comment moderation: ${auditStatus}`);
            } catch (aiError) {
                console.warn('[Auto-Guard] AI moderation failed, defaulting to pending:', aiError);
                auditStatus = 'pending';
            }
        } else {
            auditStatus = 'pending';
        }

        // Insert comment
        const result = await db.prepare(`
            INSERT INTO comments (model_id, user_id, content, ai_audit_status)
            VALUES (?, ?, ?, ?)
        `).bind(model_id, user_id, content, auditStatus).run();

        // Update user reputation if comment is safe
        if (auditStatus === 'safe') {
            await db.prepare(`
                UPDATE users SET reputation_score = reputation_score + 1 WHERE id = ?
            `).bind(user_id).run();
        } else if (auditStatus === 'unsafe') {
            // Decrease reputation for unsafe comments
            await db.prepare(`
                UPDATE users SET reputation_score = reputation_score - 5 WHERE id = ?
            `).bind(user_id).run();

            // Auto-shadowban if reputation too low
            await db.prepare(`
                UPDATE users SET is_shadowbanned = 1 WHERE id = ? AND reputation_score < -10
            `).bind(user_id).run();
        }

        return new Response(JSON.stringify({
            success: true,
            comment_id: result.meta?.last_row_id,
            audit_status: auditStatus
        }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('[Comments API] Error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
