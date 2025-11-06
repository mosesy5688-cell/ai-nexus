import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://ai-nexus.dev',
  output: 'static',
  build: { assets: '_astro' },
  integrations: [sitemap()]
});
