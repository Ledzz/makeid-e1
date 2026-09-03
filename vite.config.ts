import { defineConfig } from 'vite';

// Relative base so the build works from any GitHub Pages path (user.github.io/repo/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // Web Bluetooth requires a secure context; localhost counts as secure.
    host: 'localhost',
    port: 5173,
  },
});
