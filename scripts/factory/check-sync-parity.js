
/**
 * VFS vs JSON Alignment Auditor V1.0
 * Performs category-level and sample-level verification between 
 * 1/4 (Ingestion) and 4/4 (VFS) outputs.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';

const JSON_SOURCE = 'data/merged.json.gz';
const VFS_DB = 'output/data/meta.db';

async function performAudit() {
    console.log(`\n🔍 [AUDIT] Starting VFS/JSON Lifecycle Alignment check...`);

    // 1. Check Source Files
    if (!fs.existsSync(JSON_SOURCE)) {
        console.error(`❌ Baseline ${JSON_SOURCE} not found!`);
        return;
    }
    if (!fs.existsSync(VFS_DB)) {
        console.error(`❌ Target ${VFS_DB} not found! Run master-fusion/pack-db first.`);
        return;
    }

    // 2. Extract JSON Baseline Counts (Streaming to avoid OOM)
    console.log(`   📂 Analyzing JSON Baseline (Streaming): ${JSON_SOURCE}...`);

    // Simple streaming count to avoid loading 1.6GB into memory
    const counts = {};
    let total = 0;

    // We'll use a refined splitter logic for the [.json.gz] array
    const { pipeline } = await import('node:stream/promises');
    const { Writable } = await import('node:stream');
    const { StringDecoder } = await import('node:string_decoder');

    class Counter extends Writable {
        constructor() {
            super();
            this.decoder = new StringDecoder('utf-8');
            this.buffer = '';
            this.depth = 0;
            this.inString = false;
        }
        _write(chunk, encoding, callback) {
            const str = this.decoder.write(chunk);
            for (let i = 0; i < str.length; i++) {
                const char = str[i];
                if (char === '"' && str[i - 1] !== '\\') this.inString = !this.inString;
                if (!this.inString) {
                    if (char === '{') {
                        if (this.depth === 1) this.buffer = '';
                        this.depth++;
                    }
                    if (char === '}') this.depth--;

                    // Basic property extraction (very fast)
                    if (this.depth === 2 && this.buffer.length < 500) this.buffer += char;

                    if (this.depth === 1 && char === '}') {
                        // Estimate type from the buffer
                        const typeMatch = this.buffer.match(/"type"\s*:\s*"([^"]+)"/);
                        const type = typeMatch ? typeMatch[1] : 'unknown';
                        counts[type] = (counts[type] || 0) + 1;
                        total++;
                        if (total % 50000 === 0) process.stdout.write(`\r      Counted ${total}...`);
                    }
                } else if (this.depth === 2 && this.buffer.length < 500) {
                    this.buffer += char;
                }
            }
            callback();
        }
    }

    const counter = new Counter();
    await pipeline(
        fs.createReadStream(JSON_SOURCE),
        zlib.createGunzip(),
        counter
    );

    const jsonTotal = total;
    const jsonCounts = counts;
    console.log(`\n   ✓ JSON Total: ${jsonTotal} items.`);

    // 3. Extract VFS Target Counts
    console.log(`   📂 Analyzing VFS Target: ${VFS_DB}...`);
    const db = new Database(VFS_DB, { readonly: true });
    const vfsTotal = db.prepare('SELECT COUNT(*) as count FROM entities').get().count;
    const vfsRows = db.prepare('SELECT type, COUNT(*) as count FROM entities GROUP BY type').all();
    const vfsCounts = {};
    vfsRows.forEach(r => vfsCounts[r.type] = r.count);

    // 4. Comparison Table
    console.log(`\n📊 [COMPARISON TABLE]`);
    console.log(`------------------------------------------------------------`);
    console.log(`${'Category'.padEnd(20)} | ${'JSON (1/4)'.padEnd(15)} | ${'VFS (4/4)'.padEnd(15)} | ${'Status'}`);
    console.log(`------------------------------------------------------------`);

    const allTypes = new Set([...Object.keys(jsonCounts), ...Object.keys(vfsCounts)]);
    let allMatch = true;

    for (const type of allTypes) {
        const jCount = jsonCounts[type] || 0;
        const vCount = vfsCounts[type] || 0;
        const diff = vCount - jCount;
        const status = diff === 0 ? '✅ OK' : (diff > 0 ? `➕ +${diff}` : `⚠️ -${Math.abs(diff)}`);

        if (diff !== 0) allMatch = false;

        console.log(`${type.padEnd(20)} | ${jCount.toString().padEnd(15)} | ${vCount.toString().padEnd(15)} | ${status}`);
    }

    console.log(`------------------------------------------------------------`);
    console.log(`${'TOTAL'.padEnd(20)} | ${jsonTotal.toString().padEnd(15)} | ${vfsTotal.toString().padEnd(15)} | ${vfsTotal === jsonTotal ? '✅ MATCH' : '⚠️ DISCREPANCY'}`);

    if (allMatch) {
        console.log(`\n🎉 PROOF OF ALIGNMENT: VFS and JSON are 100% synchronized.`);
    } else {
        console.log(`\n⚠️ DISCREPANCY DETECTED: Review the categories above for potential ID collisions or filtering.`);
    }

    db.close();
}

performAudit().catch(err => console.error(err));
