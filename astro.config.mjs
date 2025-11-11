import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'url';
import path from 'path';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";

const siteUrl = 'https://free2aitools.com';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://astro.build/config
export default defineConfig({
  site: siteUrl,
  vite: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  },
  integrations: [
    react(), // Keep react() as you are using React components
    // mdx() is removed as src/content is deleted
    tailwind(), 
    sitemap({
      // Let Astro auto-discover all pages, including dynamic ones.
      // No need for `customPages` which was causing build issues.
    })
  ],
  output: 'static'
});
