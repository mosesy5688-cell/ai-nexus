/**
 * Graph Generator - V15.0
 * SPEC: SPEC-KNOWLEDGE-REPORT-V15.0
 * 
 * Generates knowledge graph JSON with nodes (Entity, Concept, Report) and edges.
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Generate knowledge graph
 * @param {Array} entities All entities
 * @param {Array} concepts Extracted concepts
 * @param {Object} options Options including reports data
 */
export async function generateGraph(entities, concepts, options = {}) {
    const nodes = [];
    const edges = [];
    const conceptMap = new Map(concepts.map(c => [c.slug, c]));

    // Add concept nodes
    for (const concept of concepts.slice(0, 100)) { // Top 100 for visualization
        nodes.push({
            id: `concept--${concept.slug}`,
            type: 'concept',
            name: concept.name,
            count: concept.count
        });
    }

    // Add top entity nodes (by FNI)
    const topEntities = entities
        .filter(e => e.fni && e.fni >= 60)
        .sort((a, b) => (b.fni || 0) - (a.fni || 0))
        .slice(0, 100);

    for (const entity of topEntities) {
        const id = entity.id || entity.slug;
        nodes.push({
            id: `entity--${id}`,
            type: entity.type || 'model',
            name: entity.name || entity.canonical_name,
            fni: entity.fni
        });

        // Create EXPLAIN edges to concepts
        const tags = entity.tags || [];
        for (const tag of tags) {
            const normalized = tag.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            if (conceptMap.has(normalized)) {
                edges.push({
                    source: `entity--${id}`,
                    target: `concept--${normalized}`,
                    type: 'EXPLAIN'
                });
            }
        }
    }

    // Add report nodes if provided
    if (options.reports) {
        for (const report of options.reports.slice(0, 10)) {
            nodes.push({
                id: `report--${report.id}`,
                type: 'report',
                name: report.title,
                date: report.date
            });

            // FEATURES edges to top models
            if (report.featured_models) {
                for (const modelId of report.featured_models.slice(0, 5)) {
                    edges.push({
                        source: `report--${report.id}`,
                        target: `entity--${modelId}`,
                        type: 'FEATURES'
                    });
                }
            }

            // TRENDING edges to concepts
            if (report.trending_concepts) {
                for (const conceptSlug of report.trending_concepts.slice(0, 3)) {
                    edges.push({
                        source: `report--${report.id}`,
                        target: `concept--${conceptSlug}`,
                        type: 'TRENDING'
                    });
                }
            }
        }
    }

    return {
        _v: '15.0',
        _ts: new Date().toISOString(),
        nodes,
        edges,
        stats: {
            concepts: concepts.length,
            entities: topEntities.length,
            edges: edges.length
        }
    };
}
