// Mounts the repo sync routes (D47) after bearer auth. See repos-routes.ts.

import { createExecRunner } from '../connectors/exec.ts';
import { createReposRoutes } from './repos-routes.ts';
import type { HttpModule } from './types.ts';

export const httpModule: HttpModule = {
  id: 'repos',
  order: 20,
  mount(app, ctx) {
    const runner = createExecRunner();
    app.route('/', createReposRoutes({ config: () => ctx.config(), runner: () => runner }));
  },
};
