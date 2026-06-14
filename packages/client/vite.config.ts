import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Listen on all interfaces so other machines on the LAN can join;
    // the client derives its WebSocket URL from location.hostname.
    host: true,
    port: 5273,
    strictPort: true,
    fs: {
      // The workspace-linked @mech-arena-fight/shared source lives outside this package root.
      allow: ['../..'],
    },
  },
});
