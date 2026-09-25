// The deploy manifests line each agent sees: the repo and folder that
// <ENTITY>_INFRA_REPO names for this deployment. Every infra repo is checked
// out under TRIAGE_REPOS_DIR (prod and stage share it), so this line is how
// an agent knows which one describes what this deployment runs.

import type { Config } from '../config/env.ts';
import type { Registry } from '../config/registry.ts';
import { infraRepoFor } from '../config/repos.ts';
import { pinsFor } from '../tools/code/_lib/code-tool.ts';
import type { Entity } from '../types/core.ts';

/** One line per entity, in the order given. Entities must be enabled. */
export function deployManifestLines(config: Config, registry: Registry, entities: readonly Entity[]): readonly string[] {
  const pins = pinsFor(config, registry);
  return entities.map((entity) => {
    if (pins instanceof Error) return `- Deploy manifests for ${entity}: unknown, resources/repos.json did not load.`;
    const r = infraRepoFor(registry, pins, entity);
    if (r.status !== 'ok') return `- Deploy manifests for ${entity}: not configured (${r.reason}). Record it as a gap; do not read another manifests repo instead.`;
    const where = r.path === '.' ? `repo ${r.repo}` : `repo ${r.repo}, folder ${r.path} (start path and path_glob with it)`;
    return `- Deploy manifests for ${entity}: ${where}. What is deployed and with what config comes from here only, not from the other manifests repos.`;
  });
}
