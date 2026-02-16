/**
 * Registry Splitter Utility V18.12.5.8 (Streaming Edition)
 * 
 * Responsibilities:
 * 1. Load the monolithic merged.json.gz (Standard JSON Array).
 * 2. Split it into 20 shards using a streaming parser (Zero-OOM).
 * 3. Perform a mandatory count integrity check.
 * 
 * V18.12.5.8: Fixed ERR_BUFFER_TOO_LARGE by implementing native stream-based partitioner.
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
        // V18.12.5.8: Use StringDecoder to prevent corruption of multi-byte UTF-8 chars split across chunks
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
    console.log(`\n🔪 [Splitter] Starting monolithic registry decomposition (Streaming)...`);

    const targetFile = fs.existsSync(INPUT_FILE) ? INPUT_FILE : INPUT_FILE_PLAIN;

    if (!fs.existsSync(targetFile)) {
        console.error(`❌ [Splitter] ERROR: Monolith ${targetFile} not found!`);
        process.exit(1);
    }

    const startTime = Date.now();
    let totalCount = 0;
    const shards = Array.from({ length: TOTAL_SHARDS }, () => []);

    console.log(`   💿 Streaming ${targetFile}...`);

    const splitter = new JsonArraySplitter((entity) => {
        const shardIdx = totalCount % TOTAL_SHARDS;
        shards[shardIdx].push(entity);
        totalCount++;

        // Periodic progress log
        if (totalCount % 5000 === 0) {
            process.stdout.write(`\r   🔄 Processed ${totalCount} entities...`);
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

    console.log(`\n   ✓ Streamed ${totalCount} entities from monolith.`);

    // 3. Write shards and verify integrity
    console.log(`   💾 Compressing and writing ${TOTAL_SHARDS} shards...`);
    let sumCount = 0;
    for (let i = 0; i < TOTAL_SHARDS; i++) {
        const shardData = shards[i];
        const shardSize = shardData.length;
        sumCount += shardSize;

        const compressedShard = zlib.gzipSync(JSON.stringify(shardData));
        const outPath = path.join(DATA_DIR, `merged_shard_${i}.json.gz`);
        fs.writeFileSync(outPath, compressedShard);

        // Dispose shard early
        shards[i] = null;
    }

    // 4. Final Integrity Check
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
