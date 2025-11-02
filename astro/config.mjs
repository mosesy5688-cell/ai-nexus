import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://yourusername.github.io',
  output: 'hybrid',  // ← 必须
  build: { assets: '_astro' }
});