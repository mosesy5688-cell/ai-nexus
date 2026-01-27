const fs = require('fs');
let content = fs.readFileSync('search_core.json', 'utf8');
if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
}
const data = JSON.parse(content);
const hfModels = data.entities.filter(e => e.source === 'huggingface' && e.type === 'model').slice(0, 20);
console.log(JSON.stringify(hfModels.map(m => m.id), null, 2));
