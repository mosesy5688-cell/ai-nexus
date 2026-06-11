import { xxhash64 } from '../../../src/utils/xxhash64-core.js';

// Shared slim-v2 id-index.bin fixture for the B4 absence-oracle test suites.
// Builds the SAME on-disk layout id-index-generator.js emits and
// id-index-reader.ts parses, plus a mock env.R2_ASSETS that serves it (and
// counts R2 GETs so the fan-out gate's "no cold I/O" promise is assertable).

const HEADER_SIZE = 32;
const KEY_ENTRY_SIZE = 12;
const RECORD_SIZE = 8;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;

/**
 * Build a valid slim IDIX buffer mapping each key form -> a shardIdx.
 * @param entries form -> shardIdx records.
 * @param buildId B4 coherence token. A string -> v3 header with that build_id
 *        stamped (the same layout id-index-generator.js emits). undefined -> a
 *        v2 header with NO build_id (backward-compat: reader exposes null ->
 *        incoherent -> absence proof off). This mirrors the exact byte layout
 *        the production reader parses, so coherence is exercised end-to-end.
 */
export function buildIndexBuffer(
    entries: { form: string; shardIdx: number }[],
    buildId?: string,
): ArrayBuffer {
    // Each entry gets its own record (matches the generator: every form points
    // at one record).
    const records = entries.map(e => ({ shardIdx: e.shardIdx }));
    const keys = entries.map((e, i) => ({
        hash: BigInt.asUintN(64, xxhash64(e.form.toLowerCase()) & MASK64),
        recordIdx: i,
    }));
    keys.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

    const idBytes = buildId != null ? new TextEncoder().encode(buildId) : new Uint8Array(0);
    const version = buildId != null ? 3 : 2;
    const keyTableOffset = HEADER_SIZE + idBytes.length;
    const recordTableOffset = keyTableOffset + keys.length * KEY_ENTRY_SIZE;
    const total = recordTableOffset + records.length * RECORD_SIZE;
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    bytes[0] = 'I'.charCodeAt(0); bytes[1] = 'D'.charCodeAt(0);
    bytes[2] = 'I'.charCodeAt(0); bytes[3] = 'X'.charCodeAt(0);
    dv.setUint16(4, version, true);      // version (2 = no build_id, 3 = stamped)
    dv.setUint32(8, keys.length, true);  // keyCount
    dv.setUint32(12, records.length, true); // recordCount
    dv.setUint32(16, keyTableOffset, true);
    dv.setUint32(20, recordTableOffset, true);
    dv.setUint16(24, idBytes.length, true); // buildIdLen (0 = none)
    if (idBytes.length > 0) bytes.set(idBytes, HEADER_SIZE);
    for (let i = 0; i < keys.length; i++) {
        const off = keyTableOffset + i * KEY_ENTRY_SIZE;
        dv.setBigUint64(off, keys[i].hash, true);
        dv.setUint32(off + 8, keys[i].recordIdx, true);
    }
    for (let i = 0; i < records.length; i++) {
        const off = recordTableOffset + i * RECORD_SIZE;
        dv.setUint16(off, records[i].shardIdx, true);
        dv.setUint8(off + 2, 0);   // type
        dv.setUint8(off + 3, 0);   // flags
        dv.setFloat32(off + 4, 0); // fniScore
    }
    return buf;
}

/** Mock env whose R2 binding serves the given index buffer (or 404s if null).
 * NODE_ENV=production + no SIMULATE_PRODUCTION makes the reader's isSimulating
 * guard false even under vitest's import.meta.env.DEV, so it takes the R2_ASSETS
 * branch (not the CDN fetch fallback) and reads our in-memory buffer.
 *
 * `_counter.getCalls` counts every R2 GET so the fan-out gate's "no cold I/O"
 * promise is directly assertable: a low-fan-out cold lookup must leave it at 0. */
export function mockEnv(buf: ArrayBuffer | null): any {
    const counter = { getCalls: 0 };
    return {
        NODE_ENV: 'production',
        R2_ASSETS: {
            get: async (key: string) => {
                counter.getCalls++;
                if (key !== 'data/id-index.bin' || !buf) return null;
                return { size: buf.byteLength, arrayBuffer: async () => buf };
            },
        },
        _counter: counter,
    };
}
