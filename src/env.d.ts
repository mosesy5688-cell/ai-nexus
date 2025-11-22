/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

type D1Database = import('@cloudflare/workers-types').D1Database;
type R2Bucket = import('@cloudflare/workers-types').R2Bucket;
type KVNamespace = import('@cloudflare/workers-types').KVNamespace;

interface Env {
    DB: D1Database;
    AI: any;
    ASSETS: R2Bucket;
    KV_CACHE: KVNamespace;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
    interface Locals extends Runtime { }
}
