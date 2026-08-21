import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // Where the built app is mounted. '/' for a self-hosted install, which is the
  // only case that matters to anyone running this. The hosted demo sets
  // VITE_BASE=/demo/ because it shares a domain with a landing page.
  base: process.env.VITE_BASE ?? '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5273,
    proxy: {
      '/api': {
        target: process.env.VITE_API_ORIGIN ?? 'http://localhost:5274',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    cssTarget: 'chrome110',
  },
});
