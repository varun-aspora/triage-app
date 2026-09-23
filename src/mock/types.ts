// Fixture kinds, the semantic key per kind, and the on-disk fixture shape.
//
// A semantic key holds the facts a tool call is about (entity, service, the
// tables a parsed SELECT reads, the canonical HTTP path, ...), already
// normalised by src/mock/key.ts. It is never the raw model input (D27).
import * as v from 'valibot';
import { EntitySchema, RunIdSchema, TakenAtSchema } from '../types/core.ts';

export const FIXTURE_KINDS = [
  'sql_select',
  'http_call',
  'logs_search',
  'resolve_identity',
  'get_account_statement',
  'detect_silent_reversals',
  'cbs_call',
  'slack_read',
  'doctor_probe',
] as const;
export const FixtureKindSchema = v.picklist(FIXTURE_KINDS);
export type FixtureKind = v.InferOutput<typeof FixtureKindSchema>;

// The <entity> folder of a fixture path. 'global' is for reads that belong to
// no entity, such as a Slack thread or a doctor probe of a local binary.
export const FIXTURE_ENTITIES = ['ssfb', 'atspl', 'rtl', 'global'] as const;
export const FixtureEntitySchema = v.picklist(FIXTURE_ENTITIES);
export type FixtureEntity = v.InferOutput<typeof FixtureEntitySchema>;

const Text = v.pipe(v.string(), v.minLength(1));
const Pair = v.tuple([Text, v.string()]);

export const LOGS_MODES = ['search', 'count', 'histogram'] as const;
export const LogsModeSchema = v.picklist(LOGS_MODES);
export type LogsMode = v.InferOutput<typeof LogsModeSchema>;

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const HttpMethodSchema = v.picklist(HTTP_METHODS);
export type HttpMethod = v.InferOutput<typeof HttpMethodSchema>;

// A path after canonicalPath(): leading slash, no empty segments, no trailing slash.
const CanonicalPath = v.pipe(v.string(), v.regex(/^\/$|^(\/[^/]+)+$/));

// Params are stored as text (null stays null), matching how pg sends them.
export const SqlSelectKeySchema = v.strictObject({
  entity: EntitySchema,
  service: Text,
  tables: v.pipe(v.array(Text), v.minLength(1)),
  params: v.array(v.nullable(v.string())),
});
export type SqlSelectKey = v.InferOutput<typeof SqlSelectKeySchema>;

export const HttpCallKeySchema = v.strictObject({
  entity: EntitySchema,
  service: Text,
  method: HttpMethodSchema,
  path: CanonicalPath,
  query: v.array(Pair),
});
export type HttpCallKey = v.InferOutput<typeof HttpCallKeySchema>;

// No transport field: the qw and http transports share one fixture (D44).
export const LogsSearchKeySchema = v.strictObject({
  entity: EntitySchema,
  service: Text,
  terms: v.array(Text),
  mode: LogsModeSchema,
  group_by: v.optional(Text),
});
export type LogsSearchKey = v.InferOutput<typeof LogsSearchKeySchema>;

// hop names the identity statement when one tool call runs several (T05.12).
export const ResolveIdentityKeySchema = v.strictObject({
  hop: v.optional(Text),
  ids: v.pipe(v.array(Pair), v.minLength(1)),
});
export type ResolveIdentityKey = v.InferOutput<typeof ResolveIdentityKeySchema>;

export const GetAccountStatementKeySchema = v.strictObject({
  entity: EntitySchema,
  account_id: Text,
  from: v.optional(Text),
  to: v.optional(Text),
  page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
export type GetAccountStatementKey = v.InferOutput<typeof GetAccountStatementKeySchema>;

export const DetectSilentReversalsKeySchema = v.strictObject({
  entity: EntitySchema,
  account_id: Text,
  customer_id: Text,
  since: v.optional(Text),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export type DetectSilentReversalsKey = v.InferOutput<typeof DetectSilentReversalsKeySchema>;

// cbs_call has no query (the path charset forbids it); the body is part of
// the key because a POST to the same path with a different body is a
// different call.
export const CbsCallKeySchema = v.strictObject({
  entity: EntitySchema,
  method: HttpMethodSchema,
  path: CanonicalPath,
  body: v.optional(v.unknown()),
});
export type CbsCallKey = v.InferOutput<typeof CbsCallKeySchema>;

export const SlackReadKeySchema = v.strictObject({
  channel: Text,
  thread_ts: Text,
});
export type SlackReadKey = v.InferOutput<typeof SlackReadKeySchema>;

export const DoctorProbeKeySchema = v.strictObject({
  entity: FixtureEntitySchema,
  probe: Text,
});
export type DoctorProbeKey = v.InferOutput<typeof DoctorProbeKeySchema>;

export const SEMANTIC_KEY_SCHEMAS = {
  sql_select: SqlSelectKeySchema,
  http_call: HttpCallKeySchema,
  logs_search: LogsSearchKeySchema,
  resolve_identity: ResolveIdentityKeySchema,
  get_account_statement: GetAccountStatementKeySchema,
  detect_silent_reversals: DetectSilentReversalsKeySchema,
  cbs_call: CbsCallKeySchema,
  slack_read: SlackReadKeySchema,
  doctor_probe: DoctorProbeKeySchema,
} as const satisfies Record<FixtureKind, v.GenericSchema>;

export type SemanticKeyMap = {
  [K in FixtureKind]: v.InferOutput<(typeof SEMANTIC_KEY_SCHEMAS)[K]>;
};
export type SemanticKey<K extends FixtureKind = FixtureKind> = SemanticKeyMap[K];

export const FIXTURE_SOURCES = ['hand', 'recorded'] as const;

export const FixtureMetaSchema = v.strictObject({
  source: v.picklist(FIXTURE_SOURCES),
  recorded_at: TakenAtSchema,
  run_id: v.optional(RunIdSchema),
  reviewed_by: v.optional(Text),
  reviewed_at: v.optional(TakenAtSchema),
});
export type FixtureMeta = v.InferOutput<typeof FixtureMetaSchema>;

// The file name is <hash>.json: sha256(key_string) cut to 16 hex characters.
export const FixtureHashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{16}$/));
export type FixtureHash = v.InferOutput<typeof FixtureHashSchema>;

function fixtureVariant<K extends FixtureKind>(kind: K) {
  return v.strictObject({
    schema: v.literal(1),
    kind: v.literal(kind),
    entity: FixtureEntitySchema,
    key: SEMANTIC_KEY_SCHEMAS[kind],
    key_string: Text,
    // Required: a fixture always records what the call returned, even null.
    result: v.unknown(),
    meta: FixtureMetaSchema,
  });
}

export const FixtureSchema = v.variant('kind', [
  fixtureVariant('sql_select'),
  fixtureVariant('http_call'),
  fixtureVariant('logs_search'),
  fixtureVariant('resolve_identity'),
  fixtureVariant('get_account_statement'),
  fixtureVariant('detect_silent_reversals'),
  fixtureVariant('cbs_call'),
  fixtureVariant('slack_read'),
  fixtureVariant('doctor_probe'),
]);
export type Fixture = v.InferOutput<typeof FixtureSchema>;
