import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4780', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:4780', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
