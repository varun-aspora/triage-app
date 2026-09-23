import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

// The flue() plugin reads flue.config.ts, scans 'use agent' modules and builds
// the Node server to dist/server.mjs.
export default defineConfig({
  plugins: [flue()],
});
