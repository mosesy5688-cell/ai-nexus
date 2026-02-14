
import https from 'https';

const url = 'https://cdn.free2aitools.com/cache/trending.json.gz';

https.get(url, (res) => {
    const chunks = [];
    res.on('data', d => chunks.push(d));
    res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        try {
            const data = buffer.toString();
            const json = JSON.parse(data);
            console.log('\n=== TRENDING INSPECTION ===');
            console.log('Keys:', Object.keys(json));
            if (json.models) console.log('Models Count:', json.models.length);
            if (json.papers) console.log('Papers Count:', json.papers.length);
            if (json.agents) console.log('Agents Count:', json.agents.length);

            if (json.models && json.models.length > 0) {
                console.log('Sample Model ID:', json.models[0].id);
            }
        } catch (e) {
            console.error('Parse failed:', e.message);
        }
    });
});
