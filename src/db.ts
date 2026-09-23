// Flue persistence entry (D38). Flue discovers the default export on the Node
// target; vite build bundles it and flue run loads it. Node only.
//
// TRIAGE_DB_PROVIDER picks the adapter and TRIAGE_DB_URL is its target (a file
// path for sqlite). Nothing here logs or puts TRIAGE_DB_URL in an error.

import type { PersistenceAdapter } from '@flue/runtime/adapter';
import { sqlite } from '@flue/runtime/node';
import { loadConfig, type Config } from './config/env.ts';

export class PersistenceNotBuiltError extends Error {
  override readonly name = 'PersistenceNotBuiltError';
}

export function createPersistence(config: Pick<Config, 'db'>): PersistenceAdapter {
  const provider = config.db.provider;
  switch (provider) {
    case 'sqlite':
      return sqlite(config.db.url);
    case 'postgres':
      // T09.1 replaces this branch with the @flue/postgres adapter.
      throw new PersistenceNotBuiltError(
        'postgres adapter not built (T09): TRIAGE_DB_PROVIDER=postgres is not supported yet; use TRIAGE_DB_PROVIDER=sqlite',
      );
    default: {
      const unknownProvider: never = provider;
      void unknownProvider;
      throw new PersistenceNotBuiltError('TRIAGE_DB_PROVIDER names a provider with no adapter');
    }
  }
}

export default createPersistence(loadConfig());
