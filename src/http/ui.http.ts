// Mounts the web console under /ui after bearer auth. See ui-routes.ts; which
// /ui paths are public is decided in ui-public.ts.

import { createUiRoutes } from './ui-routes.ts';
import type { HttpModule } from './types.ts';

export const httpModule: HttpModule = {
  id: 'ui',
  order: 50,
  mount(app, ctx) {
    app.route('/', createUiRoutes({ config: () => ctx.config() }));
  },
};
