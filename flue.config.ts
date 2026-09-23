import { defineConfig } from '@flue/runtime/config';

// Node target. The agent scan is narrowed to root agents only
// (src/agents/<name>.agent.ts); delegates in src/agents/delegates/ are plain
// modules and must not be registered. Keep src/ as the source root: no .flue/.
export default defineConfig({
  target: 'node',
  agents: 'agents/*.agent.ts',
});
