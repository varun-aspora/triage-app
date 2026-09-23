// Vitest setupFiles entry. Installs the same no-io guard as the bun test
// preload in every Vitest worker. The *.gen.ts lists are written by
// `bun run gen`, which the test:contract script runs first.

import { installNoIoGuard } from './no-io-guard.ts';

installNoIoGuard();
