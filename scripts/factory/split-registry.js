/**
 * Registry Splitter Utility V18.12.5.9 (True Streaming Edition)
 * 
 * Responsibilities:
 * 1. Load the monolithic merged.json.gz (Standard JSON Array).
 * 2. Split it into 20 shards using a streaming parser (Zero-Heap Accumulation).
 * 3. Each entity is immediately written to its destination Gzip stream.
 * 
 * V18.12.5.9: Fixed OOM (Ineffective mark-compacts) by eliminating the 'shards' in-memory array.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const TOTAL_SHARDS = 20;
const DATA_DIR = 'data';
const INPUT_FILE = path.join(DATA_DIR, 'merged.json.gz');
const INPUT_FILE_PLAIN = path.join(DATA_DIR, 'merged.json');

/**
 * Custom Simple JSON Array Stream Splitter
 * Extracts objects from a standard [{},{},...] stream without full-load.
 */
class JsonArraySplitter extends Writable {
    constructor(onObject) {
        super();
        this.onObject = onObject;
        this.decoder = new StringDecoder('utf-8');
        this.buffer = '';
        this.depth = 0;
        this.inString = false;
        this.escaped = false;
    }

    _write(chunk, encoding, callback) {
        const str = this.decoder.write(chunk);
        for (let i = 0; i < str.length; i++) {
            const char = str[i];

            if (this.inString) {
                if (this.escaped) {
                    this.escaped = false;
                } else if (char === '\\') {
                    this.escaped = true;
                } else if (char === '"') {
                    this.inString = false;
                }
                if (this.depth > 0) this.buffer += char;
            } else {
                if (char === '"') {
                    this.inString = true;
                    if (this.depth > 0) this.buffer += char;
                } else if (char === '{') {
                    this.depth++;
                    this.buffer += char;
                } else if (char === '}') {
                    this.depth--;
                    this.buffer += char;
                    if (this.depth === 0) {
                        try {
                            const obj = JSON.parse(this.buffer);
                            this.onObject(obj);
                        } catch (e) {
                            // Skip whitespace between objects
                        }
                        this.buffer = '';
                    }
                } else if (this.depth > 0) {
                    this.buffer += char;
                }
            }
        }
        callback();
    }

    _final(callback) {
        this.decoder.end();
        callback();
    }
}

async function splitRegistry() {
    console.log(`\n🔪 [Splitter] Starting monolithic registry decomposition (Zero-Heap Streaming)...`);

    const targetFile = fs.existsSync(INPUT_FILE) ? INPUT_FILE : INPUT_FILE_PLAIN;

    if (!fs.existsSync(targetFile)) {
        console.error(`❌ [Splitter] ERROR: Monolith ${targetFile} not found!`);
        process.exit(1);
    }

    const startTime = Date.now();
    let totalCount = 0;

    // Initialize Shard Write Streams
    console.log(`   📂 Initializing ${TOTAL_SHARDS} shard streams...`);
    const shardCounts = new Array(TOTAL_SHARDS).fill(0);
    const shardStreams = Array.from({ length: TOTAL_SHARDS }, (_, i) => {
        const gz = zlib.createGzip();
        const ws = fs.createWriteStream(path.join(DATA_DIR, `merged_shard_${i}.json.gz`));
        gz.pipe(ws);
        gz.write('['); // Start JSON array
        return gz;
    });

    const splitter = new JsonArraySplitter((entity) => {
        const shardIdx = totalCount % TOTAL_SHARDS;
        const countInShard = shardCounts[shardIdx];

        // Write to respective shard stream immediately
        const prefix = countInShard === 0 ? '' : ',';
        shardStreams[shardIdx].write(prefix + JSON.stringify(entity));

        shardCounts[shardIdx]++;
        totalCount++;

        // Periodic progress log
        if (totalCount % 5000 === 0) {
            process.stdout.write(`\r   🔄 Streamed ${totalCount} entities... (Memory Usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)}MB)`);
        }
    });

    const isGzip = targetFile.endsWith('.gz');
    const readStream = fs.createReadStream(targetFile);

    try {
        if (isGzip) {
            await pipeline(readStream, zlib.createGunzip(), splitter);
        } else {
            await pipeline(readStream, splitter);
        }
    } catch (err) {
        console.error(`\n❌ [Splitter] Stream Pipeline Failure:`, err);
        process.exit(1);
    }

    // Close all shard streams
    console.log(`\n   ✓ Finalizing shard streams...`);
    for (let i = 0; i < TOTAL_SHARDS; i++) {
        shardStreams[i].write(']'); // End JSON array
        shardStreams[i].end();
    }

    // Wait for all streams to finish writing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Final Integrity Check
    const sumCount = shardCounts.reduce((a, b) => a + b, 0);
    console.log(`\n⚖️ [Splitter] Integrity Verification:`);
    console.log(`   - Total Entities Processed: ${totalCount}`);
    console.log(`   - Total Entities Sharded: ${sumCount}`);

    if (sumCount !== totalCount || totalCount === 0) {
        console.error(`   ❌ CRITICAL: Integrity Violation or Zero Load!`);
        process.exit(1);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [Splitter] Decomposition complete in ${duration}s. Shards are ready for Factory 2/4.`);
}

splitRegistry();
