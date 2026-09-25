// Mounts GET /doctor after bearer auth. See doctor-routes.ts.

import { createDoctorRoutes } from './doctor-routes.ts';
import type { HttpModule } from './types.ts';

export const httpModule: HttpModule = {
  id: 'doctor',
  order: 30,
  mount(app, ctx) {
    app.route('/', createDoctorRoutes({ config: () => ctx.config() }));
  },
};
