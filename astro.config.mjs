import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  site: 'https://ai-nexus.dev',
  integrations: [tailwind(), sitemap(), cloudflare()],
  output: 'hybrid',
  adapter: cloudflare()
});
