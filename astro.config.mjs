import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import models from './public/models.json';

const siteUrl = 'https://free2aitools.com';

// https://astro.build/config
export default defineConfig({
  site: siteUrl,
  integrations: [
    tailwind(), 
    sitemap({
      // This function ensures all dynamic model pages are included in the sitemap.
      // Dynamically create full URLs for custom pages using the siteUrl constant.
      customPages: models.map(model => `${siteUrl}/model/${model.id.replace(/\//g, '--')}`)
    })
  ],
  output: 'static'
});
