import { Env } from '../config/types';
import { writeToR2 } from './gzip';

// V6.2: Universal Entity Precompute Functions
// Separated from precompute-helpers.ts for CES compliance (<250 lines)

// V6.2: Generate trending spaces cache
export async function generateTrendingSpaces(env: Env) {
    console.log('[L8] Generating V6.2 trending spaces...');

    const spaces = await env.DB.prepare(`
        SELECT id, slug, name, author, popularity as likes,
               meta_json, source_url, created_at, updated_at
        FROM entities 
        WHERE type='space' AND popularity IS NOT NULL
        ORDER BY popularity DESC 
        LIMIT 100
    `).all();

    if (spaces.results && spaces.results.length > 0) {
        const spacesData = (spaces.results || []).map((s: any) => {
            let meta: any = {};
            try { if (s.meta_json) meta = JSON.parse(s.meta_json); } catch { }
            return {
                id: s.id,
                slug: s.slug,
                name: s.name,
                author: s.author,
                likes: s.likes || 0,
                sdk: meta.sdk || 'unknown',
                running_status: meta.running_status || 'RUNNING',
                source_url: s.source_url,
                embed_url: s.source_url ? `${s.source_url}?embed=true` : null,
                created_at: s.created_at,
                updated_at: s.updated_at
            };
        });

        await writeToR2(env, 'cache/trending_spaces.json', {
            generated_at: new Date().toISOString(),
            version: 'V6.2',
            count: spacesData.length,
            spaces: spacesData
        });
        console.log(`[L8] Trending spaces cache: ${spacesData.length} spaces`);
    } else {
        console.log('[L8] No spaces found for trending cache');
    }
}

// V6.2: Generate trending datasets cache
export async function generateTrendingDatasets(env: Env) {
    console.log('[L8] Generating V6.2 trending datasets...');

    const datasets = await env.DB.prepare(`
        SELECT id, slug, name, author, popularity as likes,
               downloads, meta_json, source_url, created_at, updated_at
        FROM entities 
        WHERE type='dataset' AND (popularity IS NOT NULL OR downloads IS NOT NULL)
        ORDER BY downloads DESC, popularity DESC 
        LIMIT 100
    `).all();

    if (datasets.results && datasets.results.length > 0) {
        const datasetsData = (datasets.results || []).map((d: any) => {
            let meta: any = {};
            try { if (d.meta_json) meta = JSON.parse(d.meta_json); } catch { }
            return {
                id: d.id,
                slug: d.slug,
                name: d.name,
                author: d.author,
                likes: d.likes || 0,
                downloads: d.downloads || 0,
                size: meta.size || null,
                format: meta.format || null,
                source_url: d.source_url,
                viewer_url: d.source_url ? `${d.source_url}/viewer` : null,
                created_at: d.created_at,
                updated_at: d.updated_at
            };
        });

        await writeToR2(env, 'cache/trending_datasets.json', {
            generated_at: new Date().toISOString(),
            version: 'V6.2',
            count: datasetsData.length,
            datasets: datasetsData
        });
        console.log(`[L8] Trending datasets cache: ${datasetsData.length} datasets`);
    } else {
        console.log('[L8] No datasets found for trending cache');
    }
}

// V6.2: Generate entity links cache for frontend relation display
export async function generateEntityLinks(env: Env) {
    console.log('[L8] Generating V6.2 entity links cache...');

    const links = await env.DB.prepare(`
        SELECT 
            el.source_id as source,
            el.target_id as target,
            el.link_type as type,
            el.confidence,
            s.name as source_name,
            s.author as source_author,
            s.type as source_type,
            t.name as target_name,
            t.author as target_author,
            t.type as target_type
        FROM entity_links el
        LEFT JOIN entities s ON el.source_id = s.id
        LEFT JOIN entities t ON el.target_id = t.id
        WHERE el.confidence >= 0.5
        ORDER BY el.confidence DESC
        LIMIT 1000
    `).all();

    const linksData = (links.results || []).map((l: any) => ({
        source: l.source,
        target: l.target,
        type: l.type,
        confidence: l.confidence,
        source_name: l.source_name || 'Unknown',
        source_author: l.source_author || 'unknown',
        source_type: l.source_type || 'model',
        target_name: l.target_name || 'Unknown',
        target_author: l.target_author || 'unknown',
        target_type: l.target_type || 'model'
    }));

    await writeToR2(env, 'cache/entity_links.json', {
        generated_at: new Date().toISOString(),
        version: 'V6.2',
        count: linksData.length,
        links: linksData
    });
    console.log(`[L8] Entity links cache: ${linksData.length} links`);
}
