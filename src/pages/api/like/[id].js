export const prerender = false;

export const POST = async ({ params, request, locals }) => {
    const { id } = params;
    const db = locals.runtime.env.DB;

    if (!id) {
        return new Response(JSON.stringify({ error: 'Model ID is required' }), { status: 400 });
    }

    try {
        // 1. Check if model exists
        const model = await db.prepare('SELECT likes FROM models WHERE id = ?').bind(id).first();

        if (!model) {
            return new Response(JSON.stringify({ error: 'Model not found' }), { status: 404 });
        }

        // 2. Increment likes
        // We use a simple increment here. In a real app, we would track user likes in a separate table.
        const result = await db.prepare('UPDATE models SET likes = likes + 1 WHERE id = ? RETURNING likes')
            .bind(id)
            .first();

        return new Response(JSON.stringify({
            success: true,
            likes: result.likes
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json'
            }
        });

    } catch (error) {
        console.error('Error liking model:', error);
        return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
    }
};
