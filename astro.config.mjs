import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build timestamp for cache-busting API requests
const BUILD_TIME = Date.now().toString();


import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: 'https://free2aitools.com',
  output: 'server',
  adapter: cloudflare({
    runtime: { mode: 'local', type: 'pages' }
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
    define: {
      'import.meta.env.PUBLIC_BUILD_TIME': JSON.stringify(BUILD_TIME)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
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