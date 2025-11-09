import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import models from './public/models.json';

// https://astro.build/config
export default defineConfig({
  site: 'https://free2aitools.com',
  integrations: [
    tailwind(), 
    sitemap({
      // This function ensures all dynamic model pages are included in the sitemap.
      customPages: models.map(model => `/model/${model.id.replace(/\//g, '--')}`)
    })
  ],
  output: 'static'
});
