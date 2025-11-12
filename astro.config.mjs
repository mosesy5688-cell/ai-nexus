import { defineConfig } from 'astro/config';
import react from "@astrojs/react";
import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前文件的目录
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://astro.build/config
export default defineConfig({
  site: 'https://free2aitools.com',
  integrations: [react()],
  vite: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      }
    }
  }
});