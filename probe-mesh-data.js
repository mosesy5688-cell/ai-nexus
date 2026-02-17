
const CDN_URL = 'https://cdn.free2aitools.com';

async function probe(path) {
    let finalPath = path;
    try {
        let res = await fetch(`${CDN_URL}/${finalPath}`);
        if (!res.ok && !finalPath.endsWith('.gz')) {
            finalPath = path + '.gz';
            res = await fetch(`${CDN_URL}/${finalPath}`);
        }
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        try {
            const ds = new DecompressionStream('gzip');
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array(buf));
                    controller.close();
                }
            }).pipeThrough(ds);
            return await new Response(stream).json();
        } catch (e) {
            return JSON.parse(new TextDecoder().decode(buf));
        }
    } catch (e) {
        return null;
    }
}

async function diagnose() {
    console.log(`--- Multi-Prefix Audit ---`);

    // 1. Check relations.json for both prefixes
    const rels = await probe('cache/relations.json');
    if (rels) {
        const list = Array.isArray(rels) ? rels : (rels.relations || []);
        const kCount = list.filter(r => r.source_id === 'knowledge--transformer' || r.target_id === 'knowledge--transformer').length;
        const cCount = list.filter(r => r.source_id === 'concept--transformer' || r.target_id === 'concept--transformer').length;
        console.log(`  - relations.json: knowledge-- count=${kCount}, concept-- count=${cCount}`);
    }

    // 2. Check knowledge-links.json schema
    const klinks = await probe('cache/relations/knowledge-links.json');
    if (klinks) {
        const links = Array.isArray(klinks) ? klinks : (klinks.links || []);
        console.log(`  - knowledge-links.json: Total links=${links.length}`);
        if (links.length > 0) {
            console.log(`  - Sample Link: ${JSON.stringify(links[0])}`);
            // Search for transformer specifically
            const matches = links.filter(l => {
                if (!l.knowledge) return false;
                return l.knowledge.some(k => (k.slug || k.id || k) === 'transformer');
            });
            console.log(`  - transformer matches=${matches.length}`);
        }
    }
}

diagnose();
