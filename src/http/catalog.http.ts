// Mounts the service registry and knowledge guide routes after bearer auth.
// See catalog-routes.ts.

import { createCatalogRoutes } from './catalog-routes.ts';
import type { HttpModule } from './types.ts';

export const httpModule: HttpModule = {
  id: 'catalog',
  order: 40,
  mount(app, ctx) {
    app.route('/', createCatalogRoutes({ config: () => ctx.config() }));
  },
};
