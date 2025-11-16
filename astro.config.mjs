import { defineConfig } from 'astro/config';
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import mdx from "@astrojs/mdx";
import rss from "@astrojs/rss";
import sitemap from "@astrojs/sitemap";
import icon from "astro-icon";
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the current file
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://astro.build/config
export default defineConfig({
  site: 'https://free2aitools.com',
  integrations: [react(), tailwind(), mdx(), rss(), sitemap(), icon()],
  vite: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    }
  }
});