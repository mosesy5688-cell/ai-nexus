/// <reference types="astro/client" />

type KVNamespace = import('@cloudflare/workers-types').KVNamespace;

type Runtime = import('@astrojs/cloudflare').Runtime<
  {
    // Add binding for your KV namespace here.
    AI_NEXUS_KV: KVNamespace;
  }
>;

declare namespace App {
  interface Locals extends Runtime {}
}