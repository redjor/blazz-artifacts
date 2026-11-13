import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, modulePreload: { polyfill: false } },
  // En développement, l'API tourne sur ADMIN_PORT (voir dev/run.ts).
  server: {
    port: Number(process.env.WEB_PORT) || 5173,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.ADMIN_PORT || 3000}`,
      '/favicon.png': `http://127.0.0.1:${process.env.ADMIN_PORT || 3000}`,
    },
  },
});
