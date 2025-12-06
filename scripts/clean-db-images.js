
import { getModelBySlug } from '../src/utils/db.js';

export default {
    async fetch(request, env) {
        // 1. Fetch all models with analysis_content
        const { results } = await env.DB.prepare(
            "SELECT id, analysis_content FROM models WHERE analysis_content LIKE '%![%'"
        ).all();

        console.log(`Found ${results.length} models with images in analysis.`);

        let updatedCount = 0;

        for (const model of results) {
            if (!model.analysis_content) continue;

            // Regex to find markdown images: ![alt](url)
            const regex = /!\[.*?\]\(.*?\)/g;

            if (regex.test(model.analysis_content)) {
                const cleanContent = model.analysis_content.replace(regex, '');

                // Update DB
                await env.DB.prepare(
                    "UPDATE models SET analysis_content = ? WHERE id = ?"
                ).bind(cleanContent, model.id).run();

                console.log(`Cleaned images from model: ${model.id}`);
                updatedCount++;
            }
        }

        return new Response(`Cleaned images from ${updatedCount} models.`);
    }
};
