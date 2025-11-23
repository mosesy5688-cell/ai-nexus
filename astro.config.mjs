import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import cloudflare from "@astrojs/cloudflare";
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  site: 'https://free2aitools.com',
  output: 'hybrid',
  adapter: cloudflare({
    routes: {
      extend: {
        exclude: [
          { pattern: '/_astro/*' },
          { pattern: '/favicon.svg' },
          { pattern: '/robots.txt' },
          { pattern: '/ads.txt' },
          { pattern: '/models.json' },
          { pattern: '/data/*' },
          { pattern: '/archives/*' }
        ]
      }
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