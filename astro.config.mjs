import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://yourusername.github.io',
  output: 'static',
  build: { assets: '_astro' }
});
