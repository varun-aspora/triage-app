// The web console. Built to web/dist, which the server serves under /ui
// (src/http/ui-routes.ts). The dev server proxies the API to a local
// `bun run serve`, so the token flow is the same as in production. Ports come
// from the repo's .env (or the shell): the dev server listens on
// TRIAGE_UI_DEV_PORT and proxies to TRIAGE_HTTP_PORT, where the server listens.

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const PROXIED = ['/triage', '/services', '/guides', '/repos', '/doctor', '/ui/config.json', '/ui/session'];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), 'TRIAGE_');
  const API = `http://localhost:${env.TRIAGE_HTTP_PORT || 3000}`;
  const port = Number(env.TRIAGE_UI_DEV_PORT || 5173);

  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: '/ui/',
    plugins: [react()],
    build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'assets' },
    server: {
      port,
      strictPort: true,
      proxy: Object.fromEntries(PROXIED.map((path) => [path, { target: API }])),
    },
  };
});
