import { defineConfig } from 'vitest/config';

// `--mode artifact` builds a variant for the single-file preview page
// (see scripts/inline-artifact.mjs): file downloads and the theme toggle are
// hidden there because the host page controls both.
export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: mode === 'artifact' ? 'dist-artifact' : 'dist',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
}));
