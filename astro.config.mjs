import { defineConfig } from 'astro/config';
import path from 'path';
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
    // V26.0: Manual environment-adaptive WASM loading (Option 2)
    // We disable wasmModuleImports to allow our custom loader in Node/Workerd
    wasmModuleImports: false,
    // V26.0: Explicitly disable sessions to satisfy Zero-KV Constitution
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
      // V26.0: Removed redundant wasm() and topLevelAwait() plugins.
      // We now use Vite 7 native ?url imports for environment compatibility.
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

                  // Fix reserved ASSETS binding
                  if (config.assets && config.assets.binding === 'ASSETS') {
                    delete config.assets;
                    changed = true;
                  }

                  // Fix Zero-KV configuration (remove auto-injected SESSION)
                  if (config.kv_namespaces) {
                    const filtered = config.kv_namespaces.filter(kv => kv.binding !== 'SESSION');
                    if (filtered.length !== config.kv_namespaces.length) {
                      config.kv_namespaces = filtered;
                      changed = true;
                    }
                  }

                  // Fix reserved IMAGES binding (if collision occurs)
                  if (config.images && config.images.binding === 'IMAGES') {
                    delete config.images;
                    changed = true;
                  }

                  if (changed) {
                    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
                    console.log(`[SURGICAL FIX] Patched: ${path.relative(__dirname, filePath)}`);
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
