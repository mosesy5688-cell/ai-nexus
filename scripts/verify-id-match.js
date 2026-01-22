async function verifyId() {
    console.log('Fetching graph stats...');
    const stats = await fetch('https://cdn.free2aitools.com/cache/mesh/stats.json').then(r => r.json());
    console.log('Stats:', JSON.stringify(stats, null, 2));

    const modelUrlId = 'huggingface/meta-llama/meta-llama-3-8b-instruct';
    const canonicalId = 'hf-model--meta-llama--meta-llama-3-8b-instruct';

    console.log(`Checking if ${canonicalId} exists in knowledge-links...`);
    const linksRes = await fetch('https://cdn.free2aitools.com/cache/relations/knowledge-links.json');
    const links = await linksRes.json();

    const found = links.links.filter(l => l.entity_id === canonicalId || l.entity_id === `hf-model--${modelUrlId.replace(/\//g, '--')}`);
    console.log('Found Links:', JSON.stringify(found, null, 2));

    console.log('Sample model IDs in links:', links.links.filter(l => l.entity_type === 'model').slice(0, 10).map(l => l.entity_id));
}

verifyId();
