export const prerender = false;

import { cleanupDescription } from '../../../utils/data-service';

export async function POST({ request, locals }) {
    // Security Check: Verify Admin Secret
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${locals.runtime.env.ADMIN_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
    }

    const db = locals.runtime.env.DB;
    const ai = locals.runtime.env.AI;

    try {
        // 1. Fetch a model that needs enrichment
        const stmt = db.prepare(`
      SELECT * FROM models 
      WHERE seo_status = 'pending' OR (seo_status IS NULL AND analysis_content IS NULL)
      LIMIT 1
    `);
        const model = await stmt.first();

        if (!model) {
            return new Response(JSON.stringify({ message: 'No models pending enrichment' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 2. Mark as processing (Lock)
        await db.prepare("UPDATE models SET seo_status = 'processing' WHERE id = ?")
            .bind(model.id)
            .run();

        // 3. Prepare Context for LLM
        const context = `
      Model Name: ${model.name}
      Author: ${model.author}
      Description: ${cleanupDescription(model.description || '').substring(0, 1000)}
      Pipeline Tag: ${model.pipeline_tag || 'Unknown'}
      Likes: ${model.likes}
    `.trim();

        const prompt = `
      Act as a Senior AI Researcher. Write a comprehensive, technical yet accessible analysis of the following AI model.
      
      Structure the response in Markdown with these headers:
      ### What is it?
      (Explain what the model does in plain English)
      ### Key Features
      (Bulleted list of technical capabilities)
      ### Use Cases
      (3 concrete examples of how to use it)
      
      Do not invent features. If information is missing, focus on the general capabilities of this type of model (${model.pipeline_tag}).
      Keep it under 400 words.
      
      Context:
      ${context}
    `;

        // 4. Call Cloudflare Workers AI
        const response = await ai.run('@cf/meta/llama-3-8b-instruct', {
            messages: [
                { role: 'system', content: 'You are a helpful AI assistant writing technical documentation.' },
                { role: 'user', content: prompt }
            ]
        });

        const generatedContent = response.response;

        // 5. Save Result
        await db.prepare(`
      UPDATE models 
      SET analysis_content = ?, seo_status = 'done', last_enriched_at = ?
      WHERE id = ?
    `)
            .bind(generatedContent, Date.now(), model.id)
            .run();

        return new Response(JSON.stringify({
            success: true,
            model: model.id,
            content: generatedContent
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error('Enrichment Error:', e);
        // Unlock if it failed (optional: strictly speaking we might want to mark as 'error' or retry)
        if (model) {
            await db.prepare("UPDATE models SET seo_status = 'error' WHERE id = ?").bind(model.id).run();
        }
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
