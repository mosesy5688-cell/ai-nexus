/**
 * ENT-503 (I-1): version-pinned RANGE reads against data/id-index.bin.
 *
 * The id-index is no longer materialized in the isolate (the whole-blob load
 * was refused once the append-only corpus pushed the file past the 30 MB guard
 * on 2026-10-08, disabling the absence oracle everywhere). Instead the reader
 * fetches only the header and a few small key-table / record windows.
 *
 * Coherence: the header read captures the object's etag; EVERY later window
 * read is conditional on that etag (R2 onlyIf.etagMatches; CDN If-Match). If
 * the object was replaced mid-lookup (a publish between reads), the read fails
 * with IndexVersionChanged instead of mixing two bakes' bytes — so the build_id
 * that gates absence proof always describes the exact bytes that were searched.
 *
 * R2 binding primary; CDN fallback only under simulate/dev (same rule as the
 * previous whole-blob fetch). Never materializes more than the requested range.
 */

export const DEFAULT_INDEX_KEY = 'data/id-index.bin';

export class IndexVersionChanged extends Error {
    constructor(key: string) { super(`id-index ${key} changed between reads`); }
}

export interface IndexObject {
    key: string;
    etag: string;
    size: number;
}

function simulating(env: any): boolean {
    return !!env?.SIMULATE_PRODUCTION || (!!import.meta.env?.DEV && env?.NODE_ENV !== 'production');
}

function cdnUrl(key: string): string {
    return `https://cdn.free2aitools.com/${key}`;
}

function clean(e: string | null | undefined): string {
    return e ? String(e).replace(/"/g, '').replace('W/', '') : '';
}

/**
 * Read the first `length` bytes and pin the object version. Returns null when
 * the object does not exist. `bytes` may be shorter than `length` for a tiny
 * object (the caller validates against the header's own offsets).
 */
export async function readIndexHead(env: any, key: string, length: number): Promise<{ obj: IndexObject; bytes: Uint8Array } | null> {
    if (env?.R2_ASSETS && !simulating(env)) {
        const o = await env.R2_ASSETS.get(key, { range: { offset: 0, length } });
        if (!o || typeof o.arrayBuffer !== 'function') return null;
        const bytes = new Uint8Array(await o.arrayBuffer());
        return { obj: { key, etag: clean(o.etag || o.httpEtag), size: Number(o.size) || 0 }, bytes };
    }
    const res = await fetch(cdnUrl(key), { headers: { Range: `bytes=0-${length - 1}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`id-index head HTTP ${res.status}`);
    const total = Number((res.headers.get('content-range') || '').split('/')[1]) || Number(res.headers.get('content-length')) || 0;
    const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, length);
    return { obj: { key, etag: clean(res.headers.get('etag')), size: total }, bytes };
}

/**
 * Read exactly [offset, offset+length) of the PINNED object version. Throws
 * IndexVersionChanged when the etag no longer matches, and a plain Error on a
 * short read (never returns partial bytes).
 */
export async function readIndexRange(env: any, obj: IndexObject, offset: number, length: number): Promise<DataView> {
    let bytes: Uint8Array;
    if (env?.R2_ASSETS && !simulating(env)) {
        const o = await env.R2_ASSETS.get(obj.key, {
            range: { offset, length },
            onlyIf: obj.etag ? { etagMatches: obj.etag } : undefined,
        });
        if (!o) throw new IndexVersionChanged(obj.key); // deleted since the head read
        // Precondition failed -> R2 returns metadata without a body.
        if (typeof o.arrayBuffer !== 'function') throw new IndexVersionChanged(obj.key);
        if (obj.etag && clean(o.etag || o.httpEtag) && clean(o.etag || o.httpEtag) !== obj.etag) {
            throw new IndexVersionChanged(obj.key);
        }
        bytes = new Uint8Array(await o.arrayBuffer());
    } else {
        const headers: Record<string, string> = { Range: `bytes=${offset}-${offset + length - 1}` };
        if (obj.etag) headers['If-Match'] = `"${obj.etag}"`;
        const res = await fetch(cdnUrl(obj.key), { headers });
        if (res.status === 412) throw new IndexVersionChanged(obj.key);
        if (!res.ok) throw new Error(`id-index range HTTP ${res.status}`);
        const all = new Uint8Array(await res.arrayBuffer());
        bytes = res.status === 206 ? all : all.subarray(offset, offset + length);
    }
    if (bytes.byteLength !== length) {
        throw new Error(`id-index short read ${bytes.byteLength}/${length} @${offset}`);
    }
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
