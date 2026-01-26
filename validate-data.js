
import fs from 'fs';

const targets = ['imagen-3', 'imagen-2', 'gemini-1.5', 'imagen'];

function auditFile(filename) {
    console.log(`\n=== Auditing ${filename} ===`);
    try {
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'));

        // Handle different structures
        if (data.edges) { // graph.json
            const keys = Object.keys(data.edges);
            targets.forEach(t => {
                const matches = keys.filter(k => k.toLowerCase().includes(t));
                console.log(`  [${t}] Keys:`, matches);
                matches.forEach(m => console.log(`      -> Edges:`, data.edges[m]));
            });
        } else if (data.relations || Array.isArray(data)) { // explicit.json or knowledge-links.json
            const rels = data.relations || data;
            targets.forEach(t => {
                const matches = rels.filter(r => {
                    const sid = (r.source_id || r.entity_id || r.id || '').toLowerCase();
                    const tid = (r.target_id || '').toLowerCase();
                    return sid.includes(t) || tid.includes(t);
                });
                console.log(`  [${t}] Found ${matches.length} relations.`);
                matches.slice(0, 5).forEach(m => console.log(`      -> ${JSON.stringify(m)}`));
            });
        } else { // Generic object (relations.json)
            const keys = Object.keys(data);
            targets.forEach(t => {
                const matches = keys.filter(k => k.toLowerCase().includes(t));
                console.log(`  [${t}] Keys:`, matches);
            });
        }
    } catch (e) {
        console.error(`  Error reading ${filename}:`, e.message);
    }
}

auditFile('graph.json');
auditFile('explicit.json');
auditFile('knowledge-links.json');
auditFile('relations.json');
auditFile('search-core.json');
