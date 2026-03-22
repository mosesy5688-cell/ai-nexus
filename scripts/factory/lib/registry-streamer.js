/**
 * Registry Streamer Utility V25.9
 * Handles O(1) Memory Monolith Serialization for massive datasets.
 * V25.9: Zstd streaming replaces Gzip (100% Zstd Constitution).
 */
import fs from 'fs';
import { zstdCompress, createZstdCompressStream } from './zstd-helper.js';

export class RegistryStreamer {
    constructor(filePath) {
        this.filePath = filePath;
        this.writeStream = fs.createWriteStream(filePath);
        this.zst = createZstdCompressStream();
        this.zst.pipe(this.writeStream);
        this.count = 0;
        this.isClosed = false;

        this.zst.write(`{"entities":[`);
    }

    /**
     * Initialize Zstd codec (must be called before constructor)
     */
    static async init() {
        await zstdCompress(Buffer.from('init'));
    }

    /**
     * Push a single entity to the stream (O(1) memory, backpressure-safe)
     */
    async push(entity) {
        if (this.isClosed) throw new Error('[STREAMER] Cannot push to a closed stream.');
        const chunk = (this.count > 0 ? ',' : '') + JSON.stringify(entity);
        const ok = this.zst.write(chunk);
        this.count++;
        if (!ok) {
            await new Promise(resolve => this.zst.once('drain', resolve));
        }
    }

    /**
     * Finalize the stream and close files
     */
    async end() {
        if (this.isClosed) return;
        this.isClosed = true;

        const timestamp = new Date().toISOString();
        this.zst.write(`],"count":${this.count},"lastUpdated":"${timestamp}"}`);
        this.zst.end();

        return new Promise((resolve, reject) => {
            this.writeStream.on('finish', resolve);
            this.writeStream.on('error', reject);
        });
    }
}
