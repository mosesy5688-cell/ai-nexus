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
      // Let Astro auto-discover all pages, including dynamic ones.
      // No need for `customPages` which was causing build issues.
    })
  ],
  output: 'static'
});
