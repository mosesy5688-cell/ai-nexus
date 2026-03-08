import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
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
    '/model': '/models',
    '/agent': '/agents',
    '/space': '/spaces',
    '/tool': '/tools',
    '/dataset': '/datasets',
    '/paper': '/papers',
    '/compare': '/ranking'
  },
  adapter: cloudflare({
    runtime: { mode: 'local', type: 'pages' },
    // V18.2.6: Disable built-in session KV to comply with Zero-Cost Constitution
    // This suppresses the "Enabling sessions with Cloudflare KV" build step
    sessionPersistence: false
  }),
  build: {
    assets: 'assets',
    inlineStylesheets: 'never',
    format: 'directory',
  },
  image: {
    service: {
      entrypoint: 'astro/assets/services/noop'
    }
  },
  // V6.2: Sitemap disabled - using L8/R2 generated sitemap (sitemap-index.xml)
  // See SPEC_SITEMAP_V6.1.md for architecture details
  integrations: [tailwind()],
  vite: {
    plugins: [
      wasm(),
      topLevelAwait(),
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
        '@': path.resolve(__dirname, './src'),
        'sharp': path.resolve(__dirname, './src/utils/sharp-stub.js')
      }
    },
    build: {
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          manualChunks: undefined
        }
      }
    }
  }
});