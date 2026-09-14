import { defineConfig } from 'vite';

export default defineConfig({
  base: '/react-widget/dist/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '0.0.0.0',
    port: 4173,
  },
});
