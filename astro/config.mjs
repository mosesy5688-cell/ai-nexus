import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ai-nexus.pages.dev',  // Cloudflare Pages 域名
  output: 'static',  // ← 关键！Cloudflare Pages 要求静态
  build: { assets: '_astro' }
});