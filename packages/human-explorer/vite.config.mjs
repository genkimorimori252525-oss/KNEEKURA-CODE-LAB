import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = fileURLToPath(
  new URL('../..', import.meta.url)
);

export default defineConfig({
  root,
  base: './',
  server: {
    fs: {
      allow: [repositoryRoot]
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
