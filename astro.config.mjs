import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import cloudflare from "@astrojs/cloudflare";
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  site: 'https://free2aitools.com',
  output: 'server', // SSR mode for D1 database
  build: {
    assets: 'assets',
    inlineStylesheets: 'never', // Keep CSS external for caching
    format: 'directory',
  },
  adapter: cloudflare({
    mode: 'directory',
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
    },
    build: {
      // V9.70: Prevent CSS code splitting for SSR pages
      // This ensures all Tailwind styles are available on detail pages
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          // Force single CSS bundle to prevent missing styles
          manualChunks: undefined
        }
      }
    }
  }
});