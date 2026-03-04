/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

type R2Bucket = import('@cloudflare/workers-types').R2Bucket;

interface Env {
    AI: any;
    R2_ASSETS: R2Bucket;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
    interface Locals extends Runtime { }
}

// V22.10: wa-sqlite WASM SQLite engine (used server-side in /api/search via R2 Range VFS)
declare module 'wa-sqlite/dist/wa-sqlite-async.mjs' {
    const factory: () => Promise<any>;
    export default factory;
}
declare module 'wa-sqlite/src/sqlite-api.js' {
    const Factory: (module: any) => any;
    export default Factory;
}
declare module 'wa-sqlite/src/VFS.js' {
    export class Base {
        mxPathName: number;
        handleAsync(f: () => Promise<number>): number;
        xClose(fileId: number): number;
        xRead(fileId: number, pData: Uint8Array, iOffset: number): number;
        xWrite(fileId: number, pData: Uint8Array, iOffset: number): number;
        xTruncate(fileId: number, iSize: number): number;
        xSync(fileId: number, flags: number): number;
        xFileSize(fileId: number, pSize64: DataView): number;
        xLock(fileId: number, flags: number): number;
        xUnlock(fileId: number, flags: number): number;
        xCheckReservedLock(fileId: number, pResOut: DataView): number;
        xFileControl(fileId: number, op: number, pArg: DataView): number;
        xSectorSize(fileId: number): number;
        xDeviceCharacteristics(fileId: number): number;
        xOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): number;
        xDelete(name: string, syncDir: number): number;
        xAccess(name: string, flags: number, pResOut: DataView): number;
    }
    export const SQLITE_OK: number;
    export const SQLITE_IOERR: number;
    export const SQLITE_IOERR_READ: number;
    export const SQLITE_IOERR_SHORT_READ: number;
    export const SQLITE_CANTOPEN: number;
    export const SQLITE_NOTFOUND: number;
    export const SQLITE_READONLY: number;
    export const SQLITE_OPEN_READONLY: number;
    export const SQLITE_OPEN_CREATE: number;
    export const SQLITE_OPEN_MAIN_DB: number;
    export const SQLITE_OPEN_DELETEONCLOSE: number;
    export const SQLITE_IOCAP_IMMUTABLE: number;
}
