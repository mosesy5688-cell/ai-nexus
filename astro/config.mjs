import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind'; // 1. 引入 Tailwind 集成

// https://astro.build/config
export default defineConfig({
  site: 'https://ai-nexus.pages.dev', // Cloudflare Pages 域名
  output: 'static', // ← 关键！Cloudflare Pages 要求静态
  build: {
    assets: '_astro'
  },
  // 2. 添加集成列表
  integrations: [tailwind({
    // 可选：启用深色模式
    applyBaseStyles: true
  })]
});
