import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'url';
import path from 'path';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";

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
    tailwind(),
    react(),
    sitemap()
  ],
  output: 'static'
});
