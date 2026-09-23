// bun test preload (bunfig.toml [test].preload). Regenerates the *.gen.ts
// import lists, then installs the no-io guard before any test file loads.

import { generate, REPO_ROOT } from '../../scripts/gen-indexes.ts';
import { installNoIoGuard } from './no-io-guard.ts';

generate({ root: REPO_ROOT });
installNoIoGuard();
