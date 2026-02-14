
import { loadEntityStreams } from '../src/utils/packet-loader.ts';

async function trace() {
    const type = 'model';
    const slug = 'meta-llama/llama-3-8b';
    console.log(`Tracing loadEntityStreams for ${type}/${slug}...`);

    try {
        const result = await loadEntityStreams(type, slug);
        console.log('--- RESULT ---');
        console.log('Available:', result._meta.available);
        console.log('Source:', result._meta.source);
        console.log('Paths:', JSON.stringify(result._meta.paths, null, 2));
        console.log('Streams:', JSON.stringify(result._meta.streams, null, 2));
        console.log('Has Entity:', !!result.entity);
        if (result.entity) {
            console.log('Entity ID:', result.entity.id);
            console.log('Entity Name:', result.entity.name);
            console.log('Has HTML:', !!result.html);
            console.log('Mesh Count:', result.mesh.length);
        }
    } catch (e) {
        console.error('Fatal Error:', e);
    }
}

trace();
