import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import cloudflare from "@astrojs/cloudflare";
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  site: 'https://free2aitools.com',
  output: 'server', // Fixed: Changed from 'static' to 'server' for SSR with D1
  build: {
    assets: 'assets',
    inlineStylesheets: 'never', // Force external CSS files
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
    }
  }
});