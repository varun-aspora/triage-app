// resources/repos.json: which repos are checked out, which entities they serve,
// and the branch `triage repos sync` pins them to (D37). A pin without a
// branch follows the repo's default branch. A pin without a remote is cloned
// from the URL built from TRIAGE_GIT_PROTOCOL, TRIAGE_GIT_HOST and
// TRIAGE_GIT_ORG (D46).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { Entity } from '../types/core.ts';
import type { Config } from './env.ts';
import { RegistryError, RepoNameSchema, type Registry, type RegistryProblem } from './registry.ts';

export const REPOS_FILE = 'repos.json';
const REPOS_KEY = `resources/${REPOS_FILE}`;

// Git ref names that are also safe as a single argv element: no leading '-',
// no '..', no spaces or control characters.
export const BranchNameSchema = v.pipe(
  v.string(),
  v.regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/, 'must be a plain branch name'),
  v.check((b) => !b.endsWith('/') && !b.endsWith('.lock'), 'must be a plain branch name'),
);

// Clone URL for `triage repos sync`, set on a pin that does not live in
// TRIAGE_GIT_ORG. scp-style ssh (git@host:org/repo.git),
// ssh:// or https:// only, with no user info other than 'git@', so no
// credentials or other git transports (ext::, file://) can be pinned.
export const RemoteUrlSchema = v.pipe(
  v.string(),
  v.regex(
    /^(?:git@[A-Za-z0-9.-]+:|ssh:\/\/git@[A-Za-z0-9.-]+(?::[0-9]+)?\/|https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,
    'must be a git@host:org/repo, ssh://git@host/ or https://host/ URL without credentials',
  ),
  v.check((u) => !u.includes('..'), 'must be a git@host:org/repo, ssh://git@host/ or https://host/ URL without credentials'),
);

export const RepoPinSchema = v.strictObject({
  repo: RepoNameSchema,
  entities: v.pipe(v.array(v.string()), v.minLength(1, 'must list at least one entity')),
  /** Absent means the repo's default branch. */
  branch: v.optional(BranchNameSchema),
  /** Where `triage repos sync` clones a missing repo from. Absent means the URL built from TRIAGE_GIT_*. */
  remote: v.optional(RemoteUrlSchema),
});

export type RepoPin = {
  readonly repo: string;
  readonly entities: readonly Entity[];
  /** undefined means the repo's default branch. */
  readonly branch?: string;
  /** undefined means the URL built from TRIAGE_GIT_PROTOCOL, TRIAGE_GIT_HOST and TRIAGE_GIT_ORG. */
  readonly remote?: string;
};

export const ReposFileSchema = v.array(RepoPinSchema);

export type LoadReposOptions = {
  /** Defaults to config.paths.resourcesDir. */
  readonly resourcesDir?: string;
};

/** Reads resources/repos.json and validates it against the registry. */
export function loadRepos(config: Config, registry: Registry, options: LoadReposOptions = {}): readonly RepoPin[] {
  const file = join(options.resourcesDir ?? config.paths.resourcesDir, REPOS_FILE);
  if (!existsSync(file)) throw RegistryError.of(REPOS_KEY, 'is missing');
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw RegistryError.of(REPOS_KEY, 'is not valid JSON');
  }
  return parseRepos(doc, registry);
}

/** Pure part of loadRepos. Entities must be registry ids, not aliases. */
export function parseRepos(doc: unknown, registry: Registry): readonly RepoPin[] {
  const parsed = v.safeParse(ReposFileSchema, doc);
  if (!parsed.success) {
    throw new RegistryError(
      parsed.issues.map((issue) => ({ key: REPOS_KEY, reason: `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}` })),
    );
  }
  const problems: RegistryProblem[] = [];
  const seen = new Set<string>();
  const pins: RepoPin[] = [];
  parsed.output.forEach((pin, i) => {
    if (seen.has(pin.repo)) problems.push({ key: REPOS_KEY, reason: `[${i}] repeats repo ${pin.repo}` });
    seen.add(pin.repo);
    const entities: Entity[] = [];
    for (const name of pin.entities) {
      const entity = registry.resolveEntity(name);
      if (entity === undefined || entity !== name || !registry.entities.includes(entity)) {
        problems.push({ key: REPOS_KEY, reason: `[${i}] ${pin.repo} names an unknown entity; use one of ${registry.entities.join(', ')}` });
      } else if (!entities.includes(entity)) {
        entities.push(entity);
      }
    }
    pins.push(
      Object.freeze({
        repo: pin.repo,
        entities: Object.freeze(entities),
        ...(pin.branch === undefined ? {} : { branch: pin.branch }),
        ...(pin.remote === undefined ? {} : { remote: pin.remote }),
      }),
    );
  });
  if (problems.length > 0) throw new RegistryError(problems);
  return Object.freeze(pins);
}

export type RepoEnum = {
  /** Sorted union of repos.json and every registry repo and repos_extra entry. */
  readonly names: readonly string[];
  /** Registry repos with no pin for that entity in repos.json. */
  readonly unpinned: readonly { readonly entity: Entity; readonly repo: string }[];
};

/**
 * The repo names code tools may take. `entities` narrows both sources to
 * those entities; the default is every entity in the registry.
 */
export function repoEnum(registry: Registry, repos: readonly RepoPin[], entities?: readonly Entity[]): RepoEnum {
  const scope = entities ?? registry.entities;
  const names = new Set<string>();
  const unpinned: { entity: Entity; repo: string }[] = [];
  for (const pin of repos) {
    if (pin.entities.some((e) => scope.includes(e))) names.add(pin.repo);
  }
  for (const entity of scope) {
    for (const repo of registry.repos(entity)) {
      names.add(repo);
      if (!repos.some((p) => p.repo === repo && p.entities.includes(entity))) {
        unpinned.push(Object.freeze({ entity, repo }));
      }
    }
  }
  return Object.freeze({ names: Object.freeze([...names].sort()), unpinned: Object.freeze(unpinned) });
}

export type InfraRepoResolution =
  | { readonly status: 'ok'; readonly envName: string; readonly repo: string; readonly path: string }
  | { readonly status: 'off'; readonly envName?: string; readonly reason: string };

/**
 * The deploy manifests repo and folder this deployment reads for an enabled
 * entity: <ENTITY>_INFRA_REPO, when it is set and names a repo pinned for
 * that entity in repos.json. Reasons name keys and repos, never other values.
 */
export function infraRepoFor(registry: Registry, repos: readonly RepoPin[], entity: Entity): InfraRepoResolution {
  const cap = registry.infraRepo(entity);
  if (cap === undefined) return Object.freeze({ status: 'off', reason: `resources/${entity}.entity.json names no infra_repo key` });
  if (cap.status !== 'ok') return Object.freeze({ status: 'off', envName: cap.envName, reason: `${cap.envName} is blank` });
  if (!repos.some((p) => p.repo === cap.repo && p.entities.includes(entity))) {
    return Object.freeze({ status: 'off', envName: cap.envName, reason: `${cap.envName} names ${cap.repo}, which is not pinned for ${entity} in ${REPOS_KEY}` });
  }
  return cap;
}

/** The pinned infra repos for these entities, deduplicated. Entities must be enabled. */
export function infraRepoNames(registry: Registry, repos: readonly RepoPin[], entities: readonly Entity[]): readonly string[] {
  const names = new Set<string>();
  for (const entity of entities) {
    const r = infraRepoFor(registry, repos, entity);
    if (r.status === 'ok') names.add(r.repo);
  }
  return Object.freeze([...names]);
}
