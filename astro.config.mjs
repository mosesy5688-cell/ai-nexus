import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import cloudflare from "@astrojs/cloudflare";
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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