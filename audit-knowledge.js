
import { fetchMeshRelations, stripPrefix, isMatch } from './src/utils/knowledge-cache-reader.js';

async function auditContent(modelId) {
    console.log(`\n--- Surgical Audit for: ${modelId} ---`);

    const locals = {
        runtime: {
            env: {
                R2_ASSETS: {
                    get: async (key) => {
                        const res = await fetch(`https://cdn.free2aitools.com/${key}`);
                        if (!res.ok) return null;
                        const data = await res.json();
                        return { json: async () => data };
                    }
                }
            }
        }
    };

    try {
        const relations = await fetchMeshRelations(locals, modelId);
        const kLinks = relations.filter(r => r.target_id.includes('knowledge--'));

        console.log(`   [Mesh] Found ${kLinks.length} Knowledge Links.`);

        // Check Knowledge Index
        const kIndexRes = await fetch('https://cdn.free2aitools.com/cache/knowledge/index.json');
        const kIndex = await kIndexRes.json();
        const articles = kIndex.articles || kIndex;
        console.log(`   [Index] Total Knowledge Articles in Index: ${articles.length}`);

        for (const link of kLinks) {
            const slug = stripPrefix(link.target_id);
            const inIndex = articles.find(a => stripPrefix(a.slug || a.id) === slug);
            console.log(`      - ${link.target_id} (${slug}): ${inIndex ? `✅ FOUND IN INDEX (${inIndex.title})` : '❌ MISSING FROM INDEX'}`);

            // Try to fetch the physical content
            const contentUrl = `https://cdn.free2aitools.com/cache/knowledge/content/${slug}.json`;
            const contentRes = await fetch(contentUrl);
            console.log(`        Content: ${contentUrl} -> Status: ${contentRes.status}`);
        }

    } catch (e) {
        console.error(`   [Error] Audit failed:`, e.message);
    }
}

auditContent('hf-model--meta-llama--llama-3-70b-instruct');
