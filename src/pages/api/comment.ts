import { Ai } from '@cloudflare/ai';

export const prerender = false;

export async function POST({ request, locals }) {
    try {
        const { userId, content, modelId } = await request.json();

        if (!userId || !content || !modelId) {
            return new Response("Missing required fields", { status: 400 });
        }

        const db = locals.runtime?.env?.DB;
        const aiBinding = locals.runtime?.env?.AI;

        if (!db || !aiBinding) {
            return new Response("Services unavailable", { status: 503 });
        }

        // A. Shadowban 检查 (影子封禁)
        const user = await db.prepare("SELECT is_shadowbanned FROM users WHERE id = ?").bind(userId).first();
        if (user && user.is_shadowbanned) {
            return new Response(JSON.stringify({ status: 'success' })); // Fake success
        }

        // B. Llama-3 实时风控 (Real-time Audit)
        const ai = new Ai(aiBinding);
        const audit = await ai.run('@cf/meta/llama-3-8b-instruct', {
            prompt: `Classify this comment: "${content}". 
               Is it SPAM, HATE_SPEECH, or SAFE? 
               Answer with one word only.`
        });

        let isHidden = 0;
        let status = 'safe';

        // 简单的规则引擎
        const aiResult = ((audit as any).response || "").toUpperCase();
        if (aiResult.includes("SPAM") || aiResult.includes("HATE")) {
            isHidden = 1;
            status = 'unsafe';
            // 自动扣除信誉分 (惩罚)
            await db.prepare("UPDATE users SET reputation_score = reputation_score - 20 WHERE id = ?").bind(userId).run();
        } else {
            // 自动增加信誉分 (奖励)
            await db.prepare("UPDATE users SET reputation_score = reputation_score + 1 WHERE id = ?").bind(userId).run();
        }

        // C. 写入数据
        await db.prepare(
            "INSERT INTO comments (model_id, user_id, content, ai_audit_status, is_hidden) VALUES (?, ?, ?, ?, ?)"
        ).bind(modelId, userId, content, status, isHidden).run();

        // D. 自动封禁触发器 (阈值检查)
        await db.prepare(
            "UPDATE users SET is_shadowbanned = 1 WHERE id = ? AND reputation_score < -100"
        ).bind(userId).run();

        return new Response(JSON.stringify({ status: isHidden ? 'pending_review' : 'success' }));
    } catch (error) {
        console.error("Comment submission error:", error);
        return new Response("Internal Server Error", { status: 500 });
    }
}
