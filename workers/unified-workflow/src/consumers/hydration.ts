
import { Env } from '../config/types';
import { deriveEntityType } from '../utils/entity-helper';
import { writeToR2 } from '../utils/gzip';

export async function consumeHydrationQueue(batch: any, env: Env): Promise<void> {
    const schemaHash = 'sha256:' + Date.now().toString(36);
    const contractVersion = 'entity-cache@1.0';

    const materialize = async (body: any) => {
        const { model, relatedLinks } = body;
        const slug = model.slug || model.id.replace(/\//g, '--');
        const entityType = deriveEntityType(model.id);

        const entityCache = {
            contract_version: contractVersion,
            schema_hash: schemaHash,
            entity: { ...model, entity_type: entityType },
            computed: {
                fni: model.fni_score ? { score: model.fni_score, deploy_score: model.deploy_score || 0 } : null,
                benchmarks: [],
                relations: { links: relatedLinks, link_count: relatedLinks.length }
            },
            seo: {
                title: `${model.name} by ${model.author || 'Unknown'} | Free AI Tools`,
                description: model.seo_summary || model.description?.slice(0, 160) || `Explore ${model.name}.`
            },
            generated_at: new Date().toISOString(),
            version: 'V5.1.2'
        };

        // Path determination (Legacy Compat + V6.2 Universal)
        // Models stay in 'cache/models' until Frontend migration in Phase 3
        let cachePath: string;
        if (entityType === 'model') {
            cachePath = `cache/models/${slug}.json`;
        } else {
            // New entities use the clean V6.2 structure
            cachePath = `cache/entities/${entityType}/${slug}.json`;
        }

        // CES V5.1.2 Art 2.4.2: Force Gzip
        await writeToR2(env, cachePath, entityCache);

        // Hash Check Optimization (Optional - To be implemented fully in Phase 4)
        // const existing = await env.R2_ASSETS.head(cachePath);
        // if (existing?.customMetadata?.sha256 === computedHash) return;
    };

    // Parallel processing with retries
    const promises = batch.messages.map(async (msg: any) => {
        try {
            await materialize(msg.body);
            msg.ack();
        } catch (err) {
            console.error('[Queue] Materialization failed:', err);
            msg.retry();
        }
    });

    await Promise.all(promises);
}
