import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative asset paths: the build works from any static host or sub-folder
  build: { chunkSizeWarningLimit: 900 },
});
