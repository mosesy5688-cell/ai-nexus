// vitest.config.ts — isolates this package's test run so vitest does NOT climb to
// the parent product repo's config. Node environment; deterministic, fixture-only;
// no live network, no model inference, no product CI coupling.
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Inline (empty) PostCSS config prevents Vite from climbing to the parent
  // product repo's postcss/tailwind config. This package has no CSS.
  css: { postcss: { plugins: [] } },
  test: {
    root: __dirname,
    environment: "node",
    include: ["test/**/*.test.ts"],
    watch: false,
  },
});
