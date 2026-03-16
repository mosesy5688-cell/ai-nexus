/**
 * Registry Streamer Utility V18.12.5.21
 * Handles O(1) Memory Monolith Serialization for massive datasets.
 */
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';

export class RegistryStreamer {
    constructor(filePath) {
        this.filePath = filePath;
        this.writeStream = fs.createWriteStream(filePath);
        this.gzip = zlib.createGzip();
        this.gzip.pipe(this.writeStream);
        this.count = 0;
        this.isClosed = false;

        this.gzip.write(`{"entities":[`);
    }

    /**
     * Push a single entity to the stream (O(1) memory, backpressure-safe)
     */
    async push(entity) {
        if (this.isClosed) throw new Error('[STREAMER] Cannot push to a closed stream.');
        const chunk = (this.count > 0 ? ',' : '') + JSON.stringify(entity);
        const ok = this.gzip.write(chunk);
        this.count++;
        if (!ok) {
            await new Promise(resolve => this.gzip.once('drain', resolve));
        }
    }

    /**
     * Finalize the stream and close files
     */
    async end() {
        if (this.isClosed) return;
        this.isClosed = true;

        const timestamp = new Date().toISOString();
        this.gzip.write(`],"count":${this.count},"lastUpdated":"${timestamp}"}`);
        this.gzip.end();

        return new Promise((resolve, reject) => {
            this.writeStream.on('finish', resolve);
            this.writeStream.on('error', reject);
        });
    }
}
