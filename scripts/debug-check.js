
import https from 'https';

const URL = 'https://free2aitools.com/cache/meta/entity_index.json';

https.get(URL, (res) => {
    console.log(`Status: ${res.statusCode}`);
    if (res.statusCode === 200) {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                console.log(`Items: ${json.length}`);
                const withFni = json.filter(i => i.stats && i.stats.fni !== null && i.stats.fni > 0);
                console.log(`With FNI > 0: ${withFni.length}`);
                console.log(`Sample: ${json[0]?.slug} (FNI: ${json[0]?.stats?.fni})`);
            } catch (e) { console.error('Invalid JSON'); }
        });
    }
}).on('error', e => console.error(e));
