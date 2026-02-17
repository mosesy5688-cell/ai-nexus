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
        let objectStart = -1;

        gunzip.on('data', (chunk) => {
            const str = chunk.toString('utf-8');
            const scanStart = buffer.length;
            buffer += str;

            for (let i = scanStart; i < buffer.length; i++) {
                const char = buffer[i];
                if (char === '"' && !escaped) inString = !inString;
                escaped = (char === '\\' && !escaped);

                if (!inString) {
                    if (char === '{') {
                        if (depth === 1) objectStart = i;
                        depth++;
                    } else if (char === '}') {
                        depth--;
                        if (depth === 1 && objectStart !== -1) {
                            try {
                                const obj = JSON.parse(buffer.substring(objectStart, i + 1));
                                if (obj.id || obj.umid) consumer(obj);
                            } catch (e) { /* malformed entity, skip */ }
                            objectStart = -1;
                        }
                    }
                }
            }

            // O(1) Memory Guard: trim consumed data after every chunk
            if (objectStart === -1) {
                // Between objects: all data consumed, release buffer
                buffer = '';
            } else {
                // Mid-object: keep only from current object start
                buffer = buffer.substring(objectStart);
                objectStart = 0;
            }
        });

        gunzip.on('end', resolve);
        gunzip.on('error', reject);
        input.on('error', reject);
        input.pipe(gunzip);
    });
}

