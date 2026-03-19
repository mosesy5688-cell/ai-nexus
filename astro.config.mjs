import { defineConfig } from 'astro/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build timestamp for cache-busting API requests
const BUILD_TIME = Date.now().toString();

import cloudflare from "@astrojs/cloudflare";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  site: 'https://free2aitools.com',
  output: 'server',
  redirects: {
    '/model': { status: 301, destination: '/models' },
    '/agent': '/agents',
    '/space': '/spaces',
    '/tool': '/tools',
    '/dataset': '/datasets',
    '/paper': '/papers',
    '/compare': '/ranking'
  },
  adapter: cloudflare({
    // V25.8.3: Use Node.js for prerendering instead of workerd to avoid
    // wrangler remote proxy session requirement in CI/GHA builds
    prerenderEnvironment: 'node',
    platformProxy: { enabled: !process.env.CI && process.env.NODE_ENV !== 'production' },
    // V26.1: wasmModuleImports disabled — we handle WASM loading manually
    // via ?url import + WebAssembly.compile() + instantiateWasm callback
    wasmModuleImports: false,
    // V26.0: Explicitly disable sessions to prevent SESSION KV binding injection
    sessions: false,
    // V26.0: Use passthrough image service to prevent IMAGES binding injection
    imageService: 'passthrough',
  }),
  build: {
    assets: 'assets',
    inlineStylesheets: 'never',
  },
  image: {
    service: {
      entrypoint: 'astro/assets/services/noop'
    }
  },
  // V6.2: Sitemap disabled - using L8/R2 generated sitemap (sitemap-index.xml)
  integrations: [],
  vite: {
    plugins: [
      // V26.2: Custom WASM plugin for CF Workers
      // Strategy: .wasm?module → bare import (external) → wrangler CompiledWasm rule
      // 1. Intercept .wasm?module imports and generate bare .wasm import
      // 2. Mark bare .wasm as Rollup external (don't try to parse binary)
      // 3. Copy WASM file to output dir so wrangler can find it
      // 4. Wrangler's CompiledWasm rule makes the import a WebAssembly.Module
      (() => {
        const WASM_MODULE_RE = /\.wasm\?module$/;
        const BARE_WASM_RE = /^\.\/.*\.wasm$/;
        const wasmFilesToCopy = new Map();
        let isBuild = false;
        return {
          name: 'cf-wasm-module',
          enforce: 'pre',
          configResolved(config) {
            isBuild = config.command === 'build';
          },
          resolveId(id, importer) {
            if (WASM_MODULE_RE.test(id)) {
              if (importer) {
                const resolved = path.resolve(path.dirname(importer), id.replace('?module', ''));
                return resolved + '?module';
              }
              return id;
            }
            // Only mark bare .wasm as external during build (for wrangler)
            if (isBuild && BARE_WASM_RE.test(id)) {
              return { id, external: true };
            }
          },
          load(id) {
            if (WASM_MODULE_RE.test(id)) {
              const wasmPath = id.replace('?module', '');
              const fileName = path.basename(wasmPath);
              if (isBuild) {
                // Prod build: bare import → wrangler resolves as CompiledWasm
                wasmFilesToCopy.set(wasmPath, fileName);
                return `import wasmModule from './${fileName}';\nexport default wasmModule;`;
              } else {
                // Dev/test (Node.js): compile from buffer (allowed in Node)
                return `
                  import { readFileSync } from 'fs';
                  const binary = readFileSync(${JSON.stringify(wasmPath)});
                  const wasmModule = new WebAssembly.Module(binary);
                  export default wasmModule;
                `;
              }
            }
          },
          generateBundle() {
            for (const [srcPath, fileName] of wasmFilesToCopy) {
              try {
                const source = fs.readFileSync(srcPath);
                this.emitFile({ type: 'asset', fileName, source });
              } catch (e) { console.warn('[cf-wasm] Failed to copy:', srcPath, e.message); }
            }
          }
        };
      })(),
      // V26.0: Fix Vite 7 SSR dep optimization CJS compat issue with cookie module
      {
        name: 'fix-ssr-cookie-compat',
        configEnvironment(name, options) {
          if (name === 'ssr' || name === 'prerender') {
            options.optimizeDeps ??= {};
            options.optimizeDeps.exclude ??= [];
            options.optimizeDeps.exclude.push('cookie');
          }
        }
      },
      // V26.0: Fix Astro 6 + Vite 7 SSR rollup input conflict with Cloudflare adapter
      {
        name: 'fix-astro6-ssr-entry',
        config(config, { command }) {
          if (command === 'build' && config.build?.ssr) {
            config.build.rollupOptions ??= {};
            // Force the adapter entrypoint to prevent "no html in SSR" error
            config.build.rollupOptions.input = '@astrojs/cloudflare/entrypoints/server.js';
          }
        }
      },
      // V26.0: Surgical removal of reserved "ASSETS" and "SESSION" bindings from ALL generated wrangler config files
      {
        name: 'fix-cloudflare-reserved-names',
        closeBundle: {
          sequential: true,
          async handler() {
            const fs = await import('fs');
            const path = await import('path');

            async function patchJson(filePath) {
              if (fs.existsSync(filePath)) {
                try {
                  const content = fs.readFileSync(filePath, 'utf-8');
                  const config = JSON.parse(content);
                  let changed = false;

                  // V26.0: DELETING ASSETS (Reserved by Astro)
                  if (config.assets && config.assets.binding === 'ASSETS') {
                    delete config.assets;
                    changed = true;
                  }

                  // V26.0: DELETING SESSION (Reserved/Not in Dashboard)
                  if (config.kv_namespaces) {
                    const originalLen = config.kv_namespaces.length;
                    config.kv_namespaces = config.kv_namespaces.filter(kv => kv.binding !== 'SESSION');
                    if (config.kv_namespaces.length !== originalLen) changed = true;
                  }

                  // V26.0: DELETING IMAGES (Reserved/Not in Dashboard)
                  if (config.images && config.images.binding === 'IMAGES') {
                    delete config.images;
                    changed = true;
                  }

                  if (changed) {
                    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
                    console.log(`[SURGICAL CLEANUP] Applied: ${path.relative(__dirname, filePath)} (Bindings removed)`);
                  }
                } catch (e) {
                  console.error(`Failed to patch ${filePath}:`, e);
                }
              }
            }

            const targets = [
              path.resolve(__dirname, 'dist/server/wrangler.json'),
              path.resolve(__dirname, 'dist/server/.prerender/wrangler.json'),
              path.resolve(__dirname, 'dist/wrangler.json'),
              path.resolve(__dirname, 'dist/_worker.js/wrangler.json')
            ];

            for (const target of targets) {
              await patchJson(target);
            }
          }
        }
      },
      // V23.10: Strip inline source maps in dev to prevent source leak in automated tests
      {
        name: 'strip-dev-sourcemaps',
        apply: 'serve',
        transform(code, id) {
          if (id.includes('node_modules')) return;
          if (code.includes('sourceMappingURL=data:')) {
            return code.replace(/\/\/[#@]\s*sourceMappingURL=data:[^\n]+/g, '');
          }
        }
      }
    ],
    ssr: {
      // Ensure wa-sqlite WASM is bundled into SSR worker, not externalized
      noExternal: ['@journeyapps/wa-sqlite']
    },
    server: {
      watch: {
        // V19.4: Ignore public/ and heavy artifacts to reduce watcher overhead
        ignored: ['**/public/**', '**/.astro/**', '**/dist/**', '**/node_modules/**']
      }
    },
    define: {
      'import.meta.env.PUBLIC_BUILD_TIME': JSON.stringify(BUILD_TIME)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    }
  }
});
