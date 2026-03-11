
import fs from 'fs';
import path from 'path';

const registryPath = 'g:/ai-nexus/cache/global-registry.json';
console.log('Reading registry:', registryPath);

const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const entities = Array.isArray(data) ? data : (data.entities || []);

const typeCounts = {};
const samples = { agent: [], prompt: [] };

entities.forEach(e => {
    const type = e.type || e.entity_type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    
    if (type === 'agent' && samples.agent.length < 5) samples.agent.push({ id: e.id, fni: e.fni_score || e.fni, stars: e.stars, downloads: e.downloads });
    if (type === 'prompt' && samples.prompt.length < 5) samples.prompt.push({ id: e.id, fni: e.fni_score || e.fni, likes: e.likes, downloads: e.downloads });
});

console.log('\nEntity Type Distribution:');
console.log(JSON.stringify(typeCounts, null, 2));

console.log('\nAgent Samples:');
console.log(JSON.stringify(samples.agent, null, 2));

console.log('\nPrompt Samples:');
console.log(JSON.stringify(samples.prompt, null, 2));
