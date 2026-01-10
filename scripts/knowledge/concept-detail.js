/**
 * Concept Detail Generator - V15.0
 * SPEC: SPEC-KNOWLEDGE-REPORT-V15.0
 * 
 * Generates individual concept detail JSON files with top models and papers.
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Generate concept detail JSON files
 * @param {Array} entities All entities
 * @param {Array} concepts Extracted concepts
 * @param {string} outputDir Output directory
 */
export async function generateConceptDetails(entities, concepts, outputDir) {
    const conceptsDir = path.join(outputDir, 'knowledge', 'concepts');
    await fs.mkdir(conceptsDir, { recursive: true });

    let generated = 0;

    for (const concept of concepts.slice(0, 100)) { // Top 100 concepts
        // Find entities related to this concept
        const relatedEntities = entities.filter(entity => {
            const tags = (entity.tags || []).map(t =>
                typeof t === 'string' ? t.toLowerCase().replace(/[^a-z0-9-]/g, '-') : ''
            );
            return tags.includes(concept.slug);
        });

        // Split by type
        const models = relatedEntities
            .filter(e => e.type === 'model' || !e.type)
            .sort((a, b) => (b.fni || 0) - (a.fni || 0))
            .slice(0, 10);

        const papers = relatedEntities
            .filter(e => e.type === 'paper')
            .sort((a, b) => (b.citations || 0) - (a.citations || 0))
            .slice(0, 5);

        const tools = relatedEntities
            .filter(e => e.type === 'tool')
            .sort((a, b) => (b.stars || 0) - (a.stars || 0))
            .slice(0, 5);

        // Find related concepts (concepts that often appear together)
        const relatedConcepts = findRelatedConcepts(concept.slug, entities, concepts);

        const detail = {
            _v: '15.0',
            _ts: new Date().toISOString(),
            slug: concept.slug,
            name: concept.name,
            count: concept.count,
            hasArticle: concept.hasArticle,
            top_models: models.map(m => ({
                id: m.id || m.slug,
                name: m.name || m.canonical_name,
                fni: m.fni,
                author: m.author
            })),
            top_papers: papers.map(p => ({
                id: p.id || p.slug,
                title: p.title || p.name,
                citations: p.citations
            })),
            top_tools: tools.map(t => ({
                id: t.id || t.slug,
                name: t.name,
                stars: t.stars
            })),
            related_concepts: relatedConcepts.slice(0, 5)
        };

        const filePath = path.join(conceptsDir, `${concept.slug}.json`);
        await fs.writeFile(filePath, JSON.stringify(detail));
        generated++;
    }

    return generated;
}

/**
 * Find concepts that often appear together with a given concept
 */
function findRelatedConcepts(conceptSlug, entities, allConcepts) {
    const cooccurrence = new Map();

    for (const entity of entities) {
        const tags = (entity.tags || []).map(t =>
            typeof t === 'string' ? t.toLowerCase().replace(/[^a-z0-9-]/g, '-') : ''
        );

        if (tags.includes(conceptSlug)) {
            for (const tag of tags) {
                if (tag !== conceptSlug && tag.length > 2) {
                    cooccurrence.set(tag, (cooccurrence.get(tag) || 0) + 1);
                }
            }
        }
    }

    // Return top co-occurring concepts
    return Array.from(cooccurrence.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([slug, count]) => ({ slug, count }));
}
