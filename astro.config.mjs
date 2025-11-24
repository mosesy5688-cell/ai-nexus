import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
    },
bindings: {
  DB: 'ai-nexus-db',
    KV_CACHE: 'ai-nexus',
      R2_ASSETS: 'ai-nexus-assets',
    }
  }),
image: {
  service: {
    entrypoint: 'astro/assets/services/noop'
  }
},
integrations: [tailwind(), sitemap()],
  vite: {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
}
});