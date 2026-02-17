/**
 * Aggregator Streaming Utilities V18.12.5.22
 * O(1) Memory Partitioner for massive JSON monoliths.
 */
import { createReadStream } from 'fs';
import zlib from 'zlib';

/**
 * Streaming Monolith Partitioner (O(1) Memory)
 * V18.12.5.21: Stability Hardening for 4GB+ Buffers
 */
export async function partitionMonolithStreamingly(filePath, consumer) {
    return new Promise((resolve, reject) => {
        const input = createReadStream(filePath);
        const gunzip = zlib.createGunzip();

        let buffer = '';
        let depth = 0;
        let inString = false;
        let escaped = false;
        let objectStartIndex = -1;

        gunzip.on('data', (chunk) => {
            const str = chunk.toString('utf-8');
            for (let i = 0; i < str.length; i++) {
                const char = str[i];
                if (char === '"' && !escaped) inString = !inString;
                escaped = (char === '\\' && !escaped);

                if (!inString) {
                    if (char === '{') {
                        if (depth === 1) objectStartIndex = buffer.length + i;
                        depth++;
                    } else if (char === '}') {
                        depth--;
                        if (depth === 1 && objectStartIndex !== -1) {
                            const fullStr = buffer + str.substring(0, i + 1);
                            const objectStr = fullStr.substring(objectStartIndex);
                            try {
                                const obj = JSON.parse(objectStr);
                                if (obj.id || obj.umid) consumer(obj);
                            } catch (e) { }
                            objectStartIndex = -1;
                        }
                    }
                }
            }
            buffer += str;
            if (depth <= 1 && objectStartIndex === -1) {
                if (buffer.length > 1024 * 1024) buffer = '';
            } else if (buffer.length > 20 * 1024 * 1024 && objectStartIndex !== -1) {
                buffer = buffer.substring(objectStartIndex);
                objectStartIndex = 0;
            }
        });

        gunzip.on('end', resolve);
        gunzip.on('error', reject);
        input.on('error', reject);
        input.pipe(gunzip);
    });
}
