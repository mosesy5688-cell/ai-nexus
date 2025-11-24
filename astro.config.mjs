import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import cloudflare from "@astrojs/cloudflare";
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  site: 'https://free2aitools.com',
  output: 'static',
  build: {
    assets: 'assets',
    inlineStylesheets: 'never', // Force external CSS files
    format: 'directory', // 🔥 V9.12: Force directory format for cache busting
    // 🔥 V9.15: PLATFORM CACHE BUST - Force complete rebuild
    // Build timestamp: 2025-11-24T18:45:00Z
  },
  adapter: cloudflare({
    mode: 'directory',
    routes: {
      strategy: 'include',
      include: ['/api/*']
    },
    bindings: {
      DB: 'ai-nexus-db',
      KV_CACHE: 'ai-nexus',
      R2_ASSETS: 'ai-nexus-assets',
    }
  }),
  image: {
    service: {
      entrypoint: 'astro/assets/services/noop'
    }
  },
  integrations: [tailwind(), sitemap()],
  vite: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    }
  }
});