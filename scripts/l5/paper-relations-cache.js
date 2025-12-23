/**
 * Paper-Relations Cache Builder
 * B.1.0 Phase 2: Paper → Model relations
 * Creates cache/paper-relations/{arxivId}.json for each paper
 * 
 * @module l5/paper-relations-cache
 */

import fs from 'fs';
import path from 'path';

/**
 * Build Paper-Model reverse index cache
 * @param {Array} relations - All discovered relations
 * @param {Array} entities - All entities with FNI scores
 * @param {string} outputDir - Output directory for cache files
 */
export async function buildPaperRelationsCache(relations, entities, outputDir) {
    console.log('\n📄 Building Paper-Relations cache (B.1.0 Phase 2)...');
    const entityMap = new Map(entities.map(e => [e.id, e]));
    const paperModelMap = new Map();

    for (const rel of relations) {
        if (rel.relation_type === 'paper_id' && rel.target_id.startsWith('arxiv:')) {
            const arxivId = rel.target_id.replace('arxiv:', '');
            if (!paperModelMap.has(arxivId)) {
                paperModelMap.set(arxivId, []);
            }
            const model = entityMap.get(rel.source_id);
            if (model) {
                paperModelMap.get(arxivId).push({
                    id: model.id,
                    name: model.name || model.id,
                    author: model.author || 'Unknown',
                    fni_score: model.fni_score || 0,
                    source: model.source || 'unknown'
                });
            }
        }
    }

    const paperRelDir = path.join(outputDir, 'paper-relations');
    if (!fs.existsSync(paperRelDir)) {
        fs.mkdirSync(paperRelDir, { recursive: true });
    }

    // Top 500 papers with most citations
    const sortedPapers = [...paperModelMap.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 500);

    let filesWritten = 0;
    for (const [arxivId, models] of sortedPapers) {
        const sortedModels = models.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
        const cacheData = {
            arxiv_id: arxivId,
            citing_models: sortedModels.slice(0, 20),
            total_citations: models.length,
            generated_at: new Date().toISOString()
        };
        fs.writeFileSync(path.join(paperRelDir, `${arxivId}.json`), JSON.stringify(cacheData));
        filesWritten++;
    }

    console.log(`   ✅ Created ${filesWritten} paper-relations cache files`);
    console.log(`   📊 Total papers with citations: ${paperModelMap.size}`);

    // Write index file
    const indexData = {
        total_papers: paperModelMap.size,
        cached_papers: filesWritten,
        top_papers: sortedPapers.slice(0, 20).map(([id, models]) => ({
            arxiv_id: id,
            citation_count: models.length
        })),
        generated_at: new Date().toISOString()
    };
    fs.writeFileSync(path.join(paperRelDir, '_index.json'), JSON.stringify(indexData, null, 2));

    return { filesWritten, totalPapers: paperModelMap.size };
}

export default { buildPaperRelationsCache };
