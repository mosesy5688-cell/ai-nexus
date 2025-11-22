import { Ai } from '@cloudflare/ai';

export interface Env {
    DB: D1Database;
    AI: any;
}

export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
        console.log("Cron job started: Auto-Enrich");

        // 1. 领取任务: 每次处理 5 个未生成的模型
        const { results } = await env.DB.prepare(
            "SELECT * FROM models WHERE seo_status = 'pending' LIMIT 5"
        ).all();

        if (!results || results.length === 0) {
            console.log("No pending models found.");
            return;
        }

        const ai = new Ai(env.AI);

        for (const model of results) {
            console.log(`Processing model: ${model.name}`);
            // 2. 自动化生成 (Llama-3)
            const prompt = `Task: Write a 150-word SEO description for AI model "${model.name}".
                      Tags: ${model.tags}. 
                      Requirement: Focus on use cases and technical strengths. English. Plain text only.`;

            try {
                const response = await ai.run('@cf/meta/llama-3-8b-instruct', { prompt }) as any;
                const seoText = response.response.trim();

                // 3. 回写数据库
                await env.DB.prepare(
                    "UPDATE models SET seo_summary = ?, seo_status = 'done' WHERE id = ?"
                ).bind(seoText, model.id).run();
                console.log(`Updated SEO for ${model.name}`);

            } catch (e) {
                console.error(`Failed to process ${model.name}:`, e);
                // 容错处理：标记失败，下次重试或忽略
                await env.DB.prepare(
                    "UPDATE models SET seo_status = 'failed' WHERE id = ?"
                ).bind(model.id).run();
            }
        }
    }
}
