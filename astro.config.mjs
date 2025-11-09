import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import models from './public/models.json';

// https://astro.build/config
export default defineConfig({
  site: 'https://ai-nexus.dev',
  integrations: [
    tailwind(), 
    sitemap({
      // This will automatically include all static pages, including the new model detail pages
    })
  ],
  output: 'static'
});
