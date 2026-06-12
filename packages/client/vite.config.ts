import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5273,
    strictPort: true,
    fs: {
      // The workspace-linked @precinct/shared source lives outside this package root.
      allow: ['../..'],
    },
  },
});
