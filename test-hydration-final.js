import { loadEntityStreams } from './src/utils/packet-loader.js';
import { hydrateEntity } from './src/utils/entity-cache-reader-core.js';

async function testHydration() {
    console.log("Testing Hydration for fka/prompts.chat...");
    // Mocking Astro locals minimally
    const locals = {
        runtime: {
            env: {
                R2_CACHE: {
                    get: async () => null // Force fallback to CDN fetch
                }
            }
        }
    };

    try {
        const { entity, html, mesh, _meta } = await loadEntityStreams('dataset', 'fka/prompts.chat', locals);

        console.log("--- RAW STREAMS ---");
        console.log("VFS Entity Name:", entity?.name);
        console.log("VFS Entity Readme Length:", entity?.html_readme?.length || 0);
        console.log("Recovered HTML Length:", html?.length || 0);
        console.log("Recovered Mesh Length:", mesh?.length || 0);

        const dataset = hydrateEntity(entity, 'dataset');
        dataset.html_readme = html || dataset.html_readme || null;

        console.log("\n--- HYDRATED DATASET ---");
        console.log("Final Readme Length:", dataset?.html_readme?.length || 0);
        console.log("Has Features:", !!dataset?.features);
        console.log("Has Rows:", !!dataset?.rows);

    } catch (err) {
        console.error("Test failed:", err);
    }
}

testHydration();
