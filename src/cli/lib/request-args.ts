// The input flags shared by `triage run` and `triage start` (HLD 02 §5.1,
// LLD 04 §2.1):
//
//   --slack-url <url> | --thread-file <path> | --text <text>   exactly one
//   --ids k=v ...          known id keys only
//   --entities <names...>  registry ids or aliases, each enabled by TRIAGE_ENTITIES; where the
//                          agent starts, not a limit (pre-flight still covers every enabled entity)
//   --tier cheap|mid|strong
//   --requested-by <who>   defaults to the OS user name
//   --interface cli|claude-code
//
// parseRequestArgs turns commander's options into a PrepareInput or throws
// UsageError. reportInputError maps the errors prepareRequest can throw to an
// exit code. Messages name the flag and the rule, never an id value or
// message text. There is no --env flag: config comes only from TRIAGE_HOME.
import { userInfo } from 'node:os';
import type { Command } from 'commander';
import type { Registry } from '../../config/registry.ts';
import { IngressInputError, NoEnabledEntityError, parseIdsFlag, type InputHints } from '../../ingress/normalise.ts';
import type { PrepareInput } from '../../ingress/prepare.ts';
import { SlackFetchError } from '../../ingress/slack.ts';
import { SlackPermalinkError } from '../../ingress/slack-url.ts';
import { WorkerPayloadError } from '../../ingress/worker-payload.ts';
import { TIERS, type Entity, type Tier } from '../../types/core.ts';
import { EXIT, printError } from '../output.ts';
import type { CliIo } from '../types.ts';

/** Interfaces a CLI caller may declare. http and slack belong to other ingress paths. */
export const CLI_INTERFACES = ['cli', 'claude-code'] as const;
export type CliInterface = (typeof CLI_INTERFACES)[number];

const INPUT_FLAGS = ['--slack-url', '--thread-file', '--text'] as const;
const ENTITY_LABEL = /^[a-z][a-z0-9_-]{0,31}$/;

/** A flag is missing, repeated or has a value the rules refuse. Exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export type RequestArgsDeps = {
  readonly registry: Pick<Registry, 'resolveEntity' | 'enabledEntities'>;
  /** Who asked when --requested-by is absent. Defaults to the OS user name. */
  readonly defaultRequestedBy?: () => string | undefined;
};

/** Adds the shared input flags to a command. */
export function configureRequestArgs(cmd: Command): Command {
  return cmd
    .option('--slack-url <url>', 'Slack thread permalink to triage')
    .option('--thread-file <path>', 'JSON file with the thread messages[] (when no bot token is set up)')
    .option('--text <text>', 'free text to triage')
    .option('--ids <pairs...>', 'known ids as key=value, e.g. customer_id=...')
    .option('--entities <names...>', 'entities to start with (ids or aliases); the agent may still brief other enabled entities')
    .option('--tier <tier>', `model tier override: ${TIERS.join('|')}`)
    .option('--requested-by <who>', 'who asked (email or Slack user id); defaults to the OS user')
    .option('--interface <name>', `caller interface: ${CLI_INTERFACES.join('|')}`, 'cli');
}

/** Builds the PrepareInput from the parsed options. Throws UsageError. */
export function parseRequestArgs(opts: Readonly<Record<string, unknown>>, deps: RequestArgsDeps): PrepareInput {
  const given = {
    slackUrl: stringOpt(opts, 'slackUrl', '--slack-url'),
    threadFile: stringOpt(opts, 'threadFile', '--thread-file'),
    text: stringOpt(opts, 'text', '--text'),
  };
  const count = [given.slackUrl, given.threadFile, given.text].filter((x) => x !== undefined).length;
  if (count !== 1) {
    const what = count === 0 ? 'none was given' : 'more than one was given';
    throw new UsageError(`give exactly one of ${INPUT_FLAGS.join(', ')} (${what})`);
  }

  const hints: { -readonly [K in keyof InputHints]: InputHints[K] } = {};
  const ids = listOpt(opts, 'ids', '--ids');
  if (ids !== undefined) {
    try {
      hints.ids = parseIdsFlag(ids);
    } catch (err) {
      if (err instanceof IngressInputError) throw new UsageError(err.message);
      throw err;
    }
  }
  const entities = listOpt(opts, 'entities', '--entities');
  if (entities !== undefined) hints.entities = checkEntities(entities, deps.registry);
  const tier = stringOpt(opts, 'tier', '--tier');
  if (tier !== undefined) hints.tier = checkTier(tier);

  const iface = checkInterface(stringOpt(opts, 'interface', '--interface') ?? 'cli');
  const requestedBy = requestedByOf(opts, deps);
  const common = {
    interface: iface,
    ...(requestedBy !== undefined ? { requested_by: requestedBy } : {}),
    ...(Object.keys(hints).length > 0 ? { hints } : {}),
  };

  if (given.slackUrl !== undefined) return { ...common, kind: 'slack', url: given.slackUrl };
  if (given.threadFile !== undefined) return { ...common, kind: 'thread_file', path: given.threadFile };
  return { ...common, kind: 'text', text: given.text as string };
}

/** --requested-by, or the default. Blank means not given. */
export function requestedByOf(opts: Readonly<Record<string, unknown>>, deps: Pick<RequestArgsDeps, 'defaultRequestedBy'>): string | undefined {
  const flag = stringOpt(opts, 'requestedBy', '--requested-by');
  if (flag !== undefined) {
    if (flag.trim() === '') throw new UsageError('--requested-by is empty');
    return flag.trim();
  }
  const fallback = (deps.defaultRequestedBy ?? osUserName)();
  return fallback !== undefined && fallback.trim() !== '' ? fallback.trim() : undefined;
}

/**
 * Resolves each name through the registry. An unknown name is refused, and so
 * is an entity TRIAGE_ENTITIES does not enable: a request may narrow the
 * deployment's entities, never widen them. Commas split a value too.
 */
export function checkEntities(values: readonly string[], registry: RequestArgsDeps['registry']): Entity[] {
  const enabled = registry.enabledEntities();
  const out: Entity[] = [];
  let n = 0;
  for (const value of values) {
    for (const part of value.split(',')) {
      n++;
      const name = part.trim().toLowerCase();
      if (name === '') throw new UsageError(`--entities entry ${n} is empty`);
      const entity = registry.resolveEntity(name);
      const label = ENTITY_LABEL.test(name) ? name : `entry ${n}`;
      if (entity === undefined) throw new UsageError(`--entities ${label} is not a registry entity id or alias`);
      if (!enabled.includes(entity)) {
        throw new UsageError(
          `--entities ${label} is not enabled by TRIAGE_ENTITIES (${enabled.join(', ') || 'none'}); a request may narrow the entities, never widen them`,
        );
      }
      if (!out.includes(entity)) out.push(entity);
    }
  }
  return out;
}

export function checkTier(value: string): Tier {
  const tier = value.trim().toLowerCase();
  if (!(TIERS as readonly string[]).includes(tier)) throw new UsageError(`--tier must be one of ${TIERS.join(', ')}`);
  return tier as Tier;
}

export function checkInterface(value: string): CliInterface {
  if (!(CLI_INTERFACES as readonly string[]).includes(value)) {
    throw new UsageError(`--interface must be one of ${CLI_INTERFACES.join(', ')}`);
  }
  return value as CliInterface;
}

/**
 * Prints an input error and returns its exit code, or undefined when the
 * error is not an input error (the caller rethrows it). Usage and input
 * problems exit 2; a failed Slack read exits 1 and its message carries the
 * --thread-file hint.
 */
export function reportInputError(io: Pick<CliIo, 'stdout' | 'stderr'>, json: boolean, err: unknown): number | undefined {
  if (
    err instanceof UsageError ||
    err instanceof IngressInputError ||
    err instanceof SlackPermalinkError ||
    err instanceof NoEnabledEntityError ||
    err instanceof WorkerPayloadError
  ) {
    printError(io, json, 'USAGE', err.message);
    return EXIT.USAGE;
  }
  if (err instanceof SlackFetchError) {
    printError(io, json, 'ERROR', err.message);
    return EXIT.ERROR;
  }
  return undefined;
}

// ------------------------------------------------------------------ helpers

function stringOpt(opts: Readonly<Record<string, unknown>>, key: string, flag: string): string | undefined {
  const value = opts[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new UsageError(`${flag} takes one value`);
  return value;
}

function listOpt(opts: Readonly<Record<string, unknown>>, key: string, flag: string): string[] | undefined {
  const value = opts[key];
  if (value === undefined) return undefined;
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw new UsageError(`${flag} takes text values`);
  if (list.length === 0) throw new UsageError(`${flag} needs at least one value`);
  return list as string[];
}

function osUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}
