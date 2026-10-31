import type { Server } from 'node:http';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Shared rooms on the dev server too, at the same /collab address as in production. */
const rooms = (): Plugin => ({
  name: 'chemcanvas-rooms',
  async configureServer(server) {
    if (!server.httpServer) return;
    const { attachRooms } = (await server.ssrLoadModule('/server/rooms.ts')) as typeof import('./server/rooms');
    attachRooms(server.httpServer as Server);
  },
});

// `--mode artifact` builds a variant for the single-file preview page
// (see scripts/inline-artifact.mjs): file downloads, the theme toggle and
// shared drawings are left out there because the host page has no server.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [rooms()],
  build: {
    outDir: mode === 'artifact' ? 'dist-artifact' : 'dist',
    emptyOutDir: true,
    // One bundle and no dynamic imports, so the preload polyfill would be dead code.
    modulePreload: { polyfill: false },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
}));
