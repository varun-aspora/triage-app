// The web console. Built to web/dist, which the server serves under /ui
// (src/http/ui-routes.ts). The dev server proxies the API to a local
// `bun run serve`, so the token flow is the same as in production.

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = 'http://localhost:3000';
const PROXIED = ['/triage', '/services', '/guides', '/repos', '/doctor', '/ui/config.json', '/ui/session'];

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/ui/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'assets' },
  server: {
    port: 5173,
    proxy: Object.fromEntries(PROXIED.map((path) => [path, { target: API }])),
  },
});
