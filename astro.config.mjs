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
      // Add all dynamic model pages to the sitemap
      customPages: models.map(model => `/model/${model.id.replace(/\//g, '--')}`)
    })
  ],
  output: 'static'
});
