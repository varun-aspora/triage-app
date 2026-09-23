import { afterAll, describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssistantMessage, Context, FauxResponseFactory } from '@earendil-works/pi-ai';
import * as v from 'valibot';

import { configFromRecord, type Config } from '../config/env.ts';
import { createFakeModel, text } from '../mock/fake-model.ts';
import { CATEGORIES, ClassificationSchema } from '../types/classification.ts';
import type { IdChain } from '../types/id-chain.ts';
import type { ThreadMessage } from '../types/request.ts';
import {
  buildClassifierPrompt,
  CLASSIFIER_PROMPT_MARKER,
  loadCategories,
  MAX_MESSAGES,
  parseCategories,
  type CategoryEntry,
} from './prompt.ts';

// classify.ts imports models.ts, which loads config at import. Clear
// TRIAGE_HOME first so a home exported in the shell is never read.
const savedHome = process.env.TRIAGE_HOME;
delete process.env.TRIAGE_HOME;
const { classify, completeWith, defaultComplete, parseClassification, unknownClassification } = await import(
  './classify.ts'
);
afterAll(() => {
  if (savedHome !== undefined) process.env.TRIAGE_HOME = savedHome;
});

const HERE = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = join(HERE, '..', '..', 'knowledge');

const fake = createFakeModel();
fake.install();

function config(overrides: Record<string, string> = {}): Config {
  return configFromRecord({ ...fake.modelEnv, TRIAGE_KNOWLEDGE_DIR: KNOWLEDGE_DIR, ...overrides }, '/triage/home');
}

// ---------------------------------------------------------------- synthetic data (pseudonymised)

const CATS: CategoryEntry[] = parseCategories([
  {
    id: 'delivery',
    label: 'Welcome letter and delivery',
    description: 'The welcome letter was not sent or went to the wrong address.',
    signals: ['welcome letter not received'],
    subcategories: ['welcome_letter', 'address'],
    typical_entities: ['ssfb', 'atspl'],
    typical_services: ['ssfb:harbor'],
    notes: 'Usually one lookup.',
  },
  {
    id: 'unknown',
    label: 'Unknown',
    description: 'Nothing else fits.',
    signals: [],
    subcategories: [],
    typical_entities: [],
  },
]);

const PHONE = '+44 7700 900123';
const ACCOUNT = '001234567890';
const NAME = 'Asha Testuser';
const EMAIL = 'asha.testuser@example.com';

const THREAD: ThreadMessage[] = [
  {
    ts: '1700000000.000100',
    author: 'ops-agent-1',
    text: `Customer ${NAME} (${EMAIL}, ${PHONE}) says the welcome letter never arrived.`,
    is_parent: true,
  },
  { ts: '1700000100.000200', author: 'ops-agent-2', text: `Account ${ACCOUNT}, opened last week.`, is_parent: false },
  { ts: '1700000200.000300', author: 'ops-agent-1', text: 'Can we re-send it to the new address?', is_parent: false },
];

const ID_CHAIN: IdChain = {
  ids: { user_id: '0b7c2a1e-5d4f-4e3a-9b8c-7d6e5f4a3b2c', account_number: ACCOUNT, phone: PHONE },
  hops: [
    {
      from: 'phone',
      to: 'user_id',
      source: 'ssfb:harbor.users',
      status: 'resolved',
      taken_at: '2026-09-23T10:00:00.000Z',
    },
  ],
  basic_state: [],
};

const BASIC_STATE = [
  { item: 'form_status', value: 'COMPLETED', taken_at: '2026-09-23T10:00:01.000Z', source: 'ssfb:harbor.account_forms' },
  { item: 'account_freeze', value: '', taken_at: '2026-09-23T10:00:02.000Z', source: 'ssfb:cbs', status: 'unreachable' as const },
];

const IMAGE = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };

const VALID = {
  category: 'delivery',
  subcategory: 'welcome_letter',
  entities_likely: ['ssfb', 'atspl'],
  current_ask: 'Re-send the welcome letter to the new address.',
  money_moved: false,
  misdirected_funds: false,
  tier_proposed: 'cheap',
  confidence: 0.85,
  missing_info: ['the new address'],
};

const INPUT = { thread: THREAD, idChain: ID_CHAIN, basicState: BASIC_STATE, images: [] };

// A completion that records the context it was given, then answers.
function capturing(answer: string | (() => Promise<AssistantMessage>)) {
  const seen: Context[] = [];
  const complete = async (_spec: string, context: Context) => {
    seen.push(context);
    return typeof answer === 'string' ? text(answer) : answer();
  };
  return { seen, complete };
}

function userTextOf(context: Context): string {
  const msg = context.messages[0];
  if (msg === undefined || msg.role !== 'user') throw new Error('no user message');
  if (typeof msg.content === 'string') return msg.content;
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function imageCount(context: Context): number {
  const msg = context.messages[0];
  if (msg === undefined || msg.role !== 'user' || typeof msg.content === 'string') return 0;
  return msg.content.filter((b) => b.type === 'image').length;
}

function expectUnknown(result: unknown, error: RegExp) {
  expect(v.is(ClassificationSchema, result)).toBe(true);
  const c = result as v.InferOutput<typeof ClassificationSchema>;
  expect(c.category).toBe('unknown');
  expect(c.tier_proposed).toBe('strong');
  expect(c.images_seen).toBe(false);
  expect(c.classifier_error).toMatch(error);
}

// ---------------------------------------------------------------- happy path

describe('classify with the fake provider', () => {
  test('a valid response round-trips into a schema-valid Classification', async () => {
    fake.script([text(JSON.stringify(VALID))]);
    const result = await classify(INPUT, { config: config(), complete: completeWith(fake.provider), categories: CATS });
    expect(v.is(ClassificationSchema, result)).toBe(true);
    expect(result).toEqual({ ...VALID, images_seen: false } as typeof result);
    expect(result.classifier_error).toBeUndefined();
    expect(fake.pending()).toBe(0);
    expect(fake.failures()).toEqual([]);
  });

  test('the system prompt starts with the marker, so byAgent can route on it', async () => {
    fake.script([fake.byAgent({ [CLASSIFIER_PROMPT_MARKER]: [text(JSON.stringify(VALID))] })]);
    const result = await classify(INPUT, { config: config(), complete: completeWith(fake.provider), categories: CATS });
    expect(result.category).toBe('delivery');
  });

  test('loads the real categories file from the knowledge dir by default', async () => {
    const { seen, complete } = capturing(JSON.stringify(VALID));
    const result = await classify(INPUT, { config: config(), complete });
    expect(result.category).toBe('delivery');
    const system = seen[0]?.systemPrompt ?? '';
    for (const id of CATEGORIES) expect(system).toContain(`### ${id}:`);
  });

  test('JSON inside a code fence or surrounded by prose is accepted', () => {
    const fenced = parseClassification('```json\n' + JSON.stringify(VALID) + '\n```', false);
    expect(fenced.category).toBe('delivery');
    const prose = parseClassification(`Here it is: ${JSON.stringify(VALID)} done.`, false);
    expect(prose.category).toBe('delivery');
  });
});

// ---------------------------------------------------------------- failure paths

describe('failure paths return unknown and never throw', () => {
  test('garbage text', async () => {
    fake.script([text('I think this is about a letter, probably.')]);
    const result = await classify(INPUT, { config: config(), complete: completeWith(fake.provider), categories: CATS });
    expectUnknown(result, /^unparseable output/);
  });

  test('broken JSON', async () => {
    fake.script([text('{"category": "delivery", ')]);
    const result = await classify(INPUT, { config: config(), complete: completeWith(fake.provider), categories: CATS });
    expectUnknown(result, /^unparseable output/);
  });

  test('schema-invalid JSON names the paths, not the values', async () => {
    fake.script([text(JSON.stringify({ ...VALID, category: 'loans-secret-value', confidence: 2 }))]);
    const result = await classify(INPUT, { config: config(), complete: completeWith(fake.provider), categories: CATS });
    expectUnknown(result, /^schema-invalid output at /);
    expect(result.classifier_error).toContain('category');
    expect(result.classifier_error).toContain('confidence');
    expect(result.classifier_error).not.toContain('loans-secret-value');
  });

  test('a JSON array or a missing field is schema-invalid or unparseable', () => {
    expectUnknown(parseClassification('[1, 2]', false), /^unparseable output|^schema-invalid/);
    const { current_ask: _drop, ...partial } = VALID;
    expectUnknown(parseClassification(JSON.stringify(partial), false), /current_ask/);
  });

  test('a thrown provider error', async () => {
    const complete = async () => {
      throw new Error(`connection refused for ${PHONE}`);
    };
    const result = await classify(INPUT, { config: config(), complete, categories: CATS });
    expectUnknown(result, /^provider error: connection refused/);
    // The error text is masked before it is stored.
    expect(result.classifier_error).not.toContain('900123');
  });

  test('a provider error reported as stopReason error (fake provider factory throws)', async () => {
    const failing: FauxResponseFactory = () => {
      throw new Error('upstream 503');
    };
    fake.script([failing]);
    const result = await classify(INPUT, { config: config(), complete: completeWith(fake.provider), categories: CATS });
    expectUnknown(result, /^provider error: .*upstream 503/);
  });

  test('a timeout, even when the provider ignores its signal', async () => {
    let signal: AbortSignal | undefined;
    const complete = (_s: string, _c: Context, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise<AssistantMessage>(() => {});
    };
    const started = Date.now();
    const result = await classify(INPUT, { config: config(), complete, categories: CATS, timeoutMs: 20 });
    expectUnknown(result, /^timeout after 20 ms$/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
  });

  test('a caller abort', async () => {
    const controller = new AbortController();
    const complete = () => new Promise<AssistantMessage>(() => {});
    const pending = classify(INPUT, { config: config(), complete, categories: CATS, signal: controller.signal });
    controller.abort();
    expectUnknown(await pending, /^aborted by caller$/);
  });

  test('MODEL_CLASSIFIER unset is recorded, not thrown', async () => {
    const cfg = configFromRecord({ TRIAGE_KNOWLEDGE_DIR: KNOWLEDGE_DIR }, '/triage/home');
    const result = await classify(INPUT, { config: cfg, complete: async () => text(JSON.stringify(VALID)), categories: CATS });
    expectUnknown(result, /MODEL_CLASSIFIER/);
  });

  test('a missing categories file is recorded, not thrown', async () => {
    const cfg = config({ TRIAGE_KNOWLEDGE_DIR: '/triage/home/no-such-knowledge' });
    const result = await classify(INPUT, { config: cfg, complete: async () => text(JSON.stringify(VALID)) });
    expectUnknown(result, /^classifier failed/);
  });

  test('the default completion refuses a provider it does not hold, with no network call', async () => {
    // faux is registered with Flue for tests but not held by defaultComplete.
    const result = await classify(INPUT, { config: config(), categories: CATS });
    expectUnknown(result, /no default completion for provider faux/);
    await expect(defaultComplete(config())('faux/classifier', { messages: [] }, { signal: new AbortController().signal })).rejects.toThrow(
      /no default completion/,
    );
  });

  test('the default completion refuses ollama when OLLAMA_BASE_URL is blank', async () => {
    const run = defaultComplete(config())('ollama/qwen3:8b', { messages: [] }, { signal: new AbortController().signal });
    await expect(run).rejects.toThrow(/no default completion for provider ollama/);
  });

  test('unknownClassification is schema-valid and fails upward', () => {
    const c = unknownClassification('x');
    expect(v.is(ClassificationSchema, c)).toBe(true);
    expect(c).toMatchObject({ category: 'unknown', tier_proposed: 'strong', confidence: 0, classifier_error: 'x' });
  });
});

// ---------------------------------------------------------------- fields the model may not set

describe('fields owned by code', () => {
  test('classifier_error, matched_pattern_id and images_seen from the model are dropped', async () => {
    const answer = { ...VALID, classifier_error: 'made up', matched_pattern_id: 'stable-pattern-x', images_seen: true };
    fake.script([text(JSON.stringify(answer))]);
    const result = await classify(INPUT, { config: config(), complete: completeWith(fake.provider), categories: CATS });
    expect(result.classifier_error).toBeUndefined();
    expect(result.matched_pattern_id).toBeUndefined();
    expect(result.images_seen).toBe(false);
  });
});

// ---------------------------------------------------------------- images

describe('images', () => {
  test('text-only classifier model: images are not sent and images_seen is false', async () => {
    const seen: Context[] = [];
    const answer: FauxResponseFactory = (context) => {
      seen.push(context);
      return text(JSON.stringify(VALID));
    };
    fake.script([answer]);
    const result = await classify(
      { ...INPUT, images: [IMAGE] },
      { config: config(), complete: completeWith(fake.provider), categories: CATS },
    );
    expect(result.images_seen).toBe(false);
    expect(result.category).toBe('delivery');
    const context = seen[0] as Context;
    expect(imageCount(context)).toBe(0);
    expect(JSON.stringify(context)).not.toContain(IMAGE.data);
    expect(userTextOf(context)).toContain('1 screenshot(s) that are not shown to you');
  });

  test('image-capable classifier model: images are attached and images_seen is true', async () => {
    const seen: Context[] = [];
    const answer: FauxResponseFactory = (context) => {
      seen.push(context);
      return text(JSON.stringify(VALID));
    };
    fake.script([answer]);
    const cfg = config({ MODEL_CLASSIFIER: 'faux/strong' });
    const result = await classify(
      { ...INPUT, images: [IMAGE, IMAGE] },
      { config: cfg, complete: completeWith(fake.provider), categories: CATS },
    );
    expect(result.images_seen).toBe(true);
    expect(imageCount(seen[0] as Context)).toBe(2);
    expect(userTextOf(seen[0] as Context)).toContain('2 screenshot(s) are attached');
  });

  test('image-capable model without images: images_seen is false', async () => {
    fake.script([text(JSON.stringify(VALID))]);
    const cfg = config({ MODEL_CLASSIFIER: 'faux/strong' });
    const result = await classify(INPUT, { config: cfg, complete: completeWith(fake.provider), categories: CATS });
    expect(result.images_seen).toBe(false);
  });

  test('image-capable model that fails: images_seen is false', async () => {
    fake.script([text('not json')]);
    const cfg = config({ MODEL_CLASSIFIER: 'faux/strong' });
    const result = await classify(
      { ...INPUT, images: [IMAGE] },
      { config: cfg, complete: completeWith(fake.provider), categories: CATS },
    );
    expectUnknown(result, /unparseable/);
  });
});

// ---------------------------------------------------------------- redaction

describe('redaction of the prompt', () => {
  const textOnly = () => ({ input: ['text'] as const });

  test('openrouter classifier: the persisted profile masks phones, account numbers, emails and names', async () => {
    const { seen, complete } = capturing(JSON.stringify(VALID));
    const cfg = config({ MODEL_CLASSIFIER: 'openrouter/vendor/some-model' });
    const result = await classify(
      { ...INPUT, redactionNames: [NAME] },
      { config: cfg, complete, categories: CATS, imageLookup: textOnly },
    );
    expect(result.category).toBe('delivery');
    const sent = JSON.stringify(seen[0]);
    for (const secret of [PHONE, '7700 900123', ACCOUNT, EMAIL, NAME]) expect(sent).not.toContain(secret);
    // Masked values keep their last four digits only.
    expect(sent).toContain('****7890');
    // UUIDs stay, the investigation searches with them.
    expect(sent).toContain(ID_CHAIN.ids.user_id as string);
  });

  test('other providers get the model-facing profile: ids stay, email local part is masked', async () => {
    const { seen, complete } = capturing(JSON.stringify(VALID));
    await classify(INPUT, { config: config(), complete, categories: CATS });
    const sent = JSON.stringify(seen[0]);
    expect(sent).toContain(ACCOUNT);
    expect(sent).toContain(PHONE);
    expect(sent).not.toContain(EMAIL);
    expect(sent).toContain('****@example.com');
  });

  test('a credential in the thread is masked in both profiles', () => {
    const dsn = 'postgres://ro_user:hunter2-fake@db.example.invalid:5432/app';
    const thread: ThreadMessage[] = [{ ts: '1', author: 'a', text: `tried ${dsn}`, is_parent: true }];
    for (const provider of ['faux', 'openrouter']) {
      const p = buildClassifierPrompt({
        categories: CATS,
        thread,
        idChain: { ids: {}, hops: [], basic_state: [] },
        basicState: [],
        provider,
        imageCount: 0,
        imagesAttached: false,
      });
      expect(p.userText).not.toContain('hunter2-fake');
    }
  });

  test('no prior-case content and no entity credential or env value reach the prompt', async () => {
    const envValues = {
      SSFB_DB_URL: 'postgres://ro:env-secret-7f3a@ssfb-db.example.invalid:5432/harbor',
      ATSPL_API_TOKEN: 'env-token-91b2',
      OPENROUTER_API_KEY: 'sk-or-fake-4c1d',
      TRIAGE_ENV_LABEL: 'env-label-b7e0',
    };
    const cfg = config({ ...envValues, MODEL_CLASSIFIER: 'openrouter/vendor/some-model' });
    const { seen, complete } = capturing(JSON.stringify(VALID));
    // A caller that passes prior cases by mistake: the extra field is ignored.
    const withPrior = { ...INPUT, prior_cases: [{ run_id: 'PRIOR-RUN-MARKER', category: 'card', subcategory: 'prior-subcat-marker' }] };
    await classify(withPrior, { config: cfg, complete, categories: CATS, imageLookup: textOnly });
    const sent = JSON.stringify(seen[0]);
    for (const value of [...Object.values(envValues), 'PRIOR-RUN-MARKER', 'prior-subcat-marker', '/triage/home', 'openrouter/vendor']) {
      expect(sent).not.toContain(value);
    }
  });
});

// ---------------------------------------------------------------- prompt

describe('prompt', () => {
  const base = {
    categories: CATS,
    thread: THREAD,
    idChain: ID_CHAIN,
    basicState: BASIC_STATE,
    provider: 'faux',
    imageCount: 1,
    imagesAttached: false,
  };

  test('snapshot for a synthetic thread (pseudonymised data only)', () => {
    const p = buildClassifierPrompt({ ...base, provider: 'openrouter', redactionNames: [NAME] });
    expect(p.profile).toBe('persisted');
    expect(p.systemPrompt).toMatchSnapshot();
    expect(p.userText).toMatchSnapshot();
  });

  test('the latest messages are marked for current_ask', () => {
    const p = buildClassifierPrompt(base);
    const lines = p.userText.split('\n').filter((l) => /^\(\d+\)/.test(l));
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toContain('LATEST');
    expect(lines[0]).toContain('PARENT');
    expect(p.systemPrompt).toContain('current_ask: one sentence');
  });

  test('a long thread keeps the parent and the latest messages', () => {
    const long: ThreadMessage[] = Array.from({ length: MAX_MESSAGES + 10 }, (_, i) => ({
      ts: String(i),
      author: 'a',
      text: `message number ${i}`,
      is_parent: i === 0,
    }));
    const p = buildClassifierPrompt({ ...base, thread: long });
    expect(p.userText).toContain('(10 older message(s) omitted)');
    expect(p.userText).toContain('message number 0\n');
    expect(p.userText).not.toContain('message number 1\n');
    expect(p.userText).toContain(`message number ${MAX_MESSAGES + 9}`);
  });

  test('the real categories file loads and every category id is offered', async () => {
    const cats = await loadCategories(KNOWLEDGE_DIR);
    expect(cats.map((c) => c.id).sort()).toEqual([...CATEGORIES].sort());
    const p = buildClassifierPrompt({ ...base, categories: cats });
    for (const id of CATEGORIES) expect(p.systemPrompt).toContain(`"${id}"`);
  });

  test('a categories list with an unknown id is refused', () => {
    expect(() => parseCategories([{ ...CATS[0], id: 'loans' }])).toThrow();
    expect(() => parseCategories([])).toThrow();
  });
});
