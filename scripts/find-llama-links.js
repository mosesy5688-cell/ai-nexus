async function findLlama() {
    const res = await fetch('https://cdn.free2aitools.com/cache/relations/knowledge-links.json');
    const data = await res.json();
    const matches = data.links.filter(l =>
        l.entity_id.toLowerCase().includes('llama-3') ||
        l.entity_id.toLowerCase().includes('llama3')
    );
    console.log(`Found ${matches.length} matches for Llama-3`);
    console.log('Samples:', JSON.stringify(matches.slice(0, 5), null, 2));
}
findLlama();
