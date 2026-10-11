// ENT-503 test helper: a mutable mock R2 binding serving data/id-index.bin with
// R2 range + onlyIf.etagMatches semantics (precondition failure -> body-less
// object). Records every GET (offset/length/etag precondition) so tests can
// assert version pinning, read sizes and read counts. `declaredSize` lets a test
// present the object as larger than the old 30 MB whole-blob cap (production
// today: 31,499,992+ B) without allocating it.

export interface RangeGet { key: string; offset: number | null; length: number | null; etagMatches: string | null }

export interface MockRangeR2 {
    get: (key: string, opts?: any) => Promise<any>;
    publish: (buf: ArrayBuffer | null, etag: string, declaredSize?: number) => void;
    gets: RangeGet[];
    /** Called before serving each GET; may publish a new version (mid-lookup change). */
    beforeServe: ((g: RangeGet) => void) | null;
    /** Return true to make this GET throw (transient R2 error). */
    failIf: ((g: RangeGet) => boolean) | null;
    /** Return true to make this GET never settle. */
    hangIf: ((g: RangeGet) => boolean) | null;
}

export function mockRangeR2(): MockRangeR2 {
    let buf: ArrayBuffer | null = null;
    let etag = '';
    let size = 0;
    const r2: MockRangeR2 = {
        gets: [], beforeServe: null, failIf: null, hangIf: null,
        publish: (b, e, declared) => { buf = b; etag = e; size = declared ?? (b ? b.byteLength : 0); },
        get: async (key: string, opts?: any) => {
            const g: RangeGet = {
                key, offset: opts?.range?.offset ?? null, length: opts?.range?.length ?? null,
                etagMatches: opts?.onlyIf?.etagMatches ?? null,
            };
            r2.gets.push(g);
            if (r2.beforeServe) r2.beforeServe(g);
            if (r2.hangIf && r2.hangIf(g)) return new Promise(() => {});
            if (r2.failIf && r2.failIf(g)) throw new Error('transient R2 error');
            if (key !== 'data/id-index.bin' || !buf) return null;
            if (g.etagMatches && g.etagMatches !== etag) return { size, etag };
            const b = buf;
            const out = g.offset !== null ? b.slice(g.offset, g.offset + (g.length ?? b.byteLength)) : b;
            return { size, etag, arrayBuffer: async () => out };
        },
    };
    return r2;
}
