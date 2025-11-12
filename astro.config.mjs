import { defineConfig } from 'astro/config';
import react from "@astrojs/react";

// https://astro.build/config
export default defineConfig({
  site: 'https://free2aitools.com',
  integrations: [react()],
  vite: {
    // 修复开发服务器中的一些兼容性问题
    ssr: {
      noExternal: ['@astrojs/react']
    }
  }
});