import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fauxProvider, type AssistantMessage, type Context, type FauxResponseFactory } from '@earendil-works/pi-ai';
import * as runtime from '@flue/runtime';
import { hasProvider, resolveModel } from '@flue/runtime/internal';
import { configFromRecord } from '../config/env.ts';
import {
  createFakeModel,
  FAKE_MODEL_ERROR_PREFIX,
  FakeModelError,
  finish,
  firstLine,
  text,
  toolCall,
  toolCalls,
  type FakeModel,
} from './fake-model.ts';

// models.ts loads config at import; clear TRIAGE_HOME so a shell home is never read.
const savedHome = process.env.TRIAGE_HOME;
delete process.env.TRIAGE_HOME;
const models = await import('../models.ts');
if (savedHome !== undefined) process.env.TRIAGE_HOME = savedHome;

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

// Drives one model call straight through the faux provider, no Flue involved.
async function call(fake: FakeModel, systemPrompt: string | undefined, modelId = 'cheap'): Promise<AssistantMessage> {
  const model = fake.faux.getModel(modelId);
  if (model === undefined) throw new Error(`no faux model ${modelId}`);
  const context: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] };
  if (systemPrompt !== undefined) context.systemPrompt = systemPrompt;
  return fake.provider.stream(model, context).result();
}

function textOf(message: AssistantMessage): string {
  return message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

describe('models and metadata', () => {
  test('faux/strong takes images; classifier, cheap and mid are text only', () => {
    const fake = createFakeModel();
    expect(fake.provider.id).toBe('faux');
    expect(fake.provider.getModels().map((m) => m.id)).toEqual(['classifier', 'cheap', 'mid', 'strong']);
    expect(fake.faux.getModel('strong')?.input).toEqual(['text', 'image']);
    for (const id of ['classifier', 'cheap', 'mid']) expect(fake.faux.getModel(id)?.input).toEqual(['text']);
    for (const m of fake.provider.getModels()) expect(m.provider).toBe('faux');
  });

  test('after install(), the runtime registry and models.ts see the same metadata', () => {
    createFakeModel().install();
    expect(resolveModel('faux/strong').input).toContain('image');
    expect(models.acceptsImages('faux/strong')).toBe(true);
    expect(models.acceptsImages('faux/cheap')).toBe(false);
    expect(models.acceptsImages('faux/mid')).toBe(false);
    expect(models.acceptsImages('faux/classifier')).toBe(false);
  });

  test('modelEnv values are the exact faux/<id> specs', () => {
    const fake = createFakeModel();
    expect(fake.modelEnv).toEqual({
      MODEL_DECISION: 'faux/classifier',
      MODEL_TIER_CHEAP: 'faux/cheap',
      MODEL_TIER_MID: 'faux/mid',
      MODEL_TIER_STRONG: 'faux/strong',
      MODEL_CODE_WALKER: 'faux/strong',
    });
    expect(Object.isFrozen(fake.modelEnv)).toBe(true);
  });

  test('models.ts accepts every modelEnv spec once installed', () => {
    const fake = createFakeModel();
    fake.install();
    const config = configFromRecord({ ...fake.modelEnv }, '/triage/home');
    expect(models.decisionModel(config)).toBe('faux/classifier');
    expect(models.modelForTier('cheap', config)).toBe('faux/cheap');
    expect(models.modelForTier('mid', config)).toBe('faux/mid');
    expect(models.modelForTier('strong', config)).toBe('faux/strong');
    expect(models.codeWalkerModel(config)).toBe('faux/strong');
  });
});

describe('install()', () => {
  test('registers the provider through setProvider', () => {
    const spy = spyOn(runtime, 'setProvider');
    spies.push(spy);
    const fake = createFakeModel();
    fake.install();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(fake.provider);
  });

  test('keeps other registered providers', () => {
    const other = fauxProvider({ api: 'fake-model-test-other', provider: 'fake-model-test-other' });
    runtime.setProvider(other.provider);
    createFakeModel().install();
    expect(hasProvider('faux')).toBe(true);
    expect(hasProvider('fake-model-test-other')).toBe(true);
  });

  test('a second install replaces the first by id', async () => {
    const first = createFakeModel();
    first.install();
    const second = createFakeModel();
    second.install();
    expect(resolveModel('faux/cheap')).toBe(second.faux.getModel('cheap') as never);
  });
});

describe('script()', () => {
  test('serves steps in order', async () => {
    const fake = createFakeModel();
    fake.script([text('one'), text('two')]);
    expect(fake.pending()).toBe(2);
    expect(textOf(await call(fake, 'sys'))).toBe('one');
    expect(textOf(await call(fake, 'sys'))).toBe('two');
    expect(fake.pending()).toBe(0);
  });

  test('an exhausted queue gives the documented error, on every later call', async () => {
    const fake = createFakeModel();
    fake.script([text('only')]);
    await call(fake, 'You are the root.\nMore detail.');
    const first = await call(fake, 'You are the root.\nMore detail.');
    expect(first.stopReason).toBe('error');
    expect(first.errorMessage).toStartWith(`${FAKE_MODEL_ERROR_PREFIX} the scripted queue is exhausted`);
    expect(first.errorMessage).toContain('1 response(s) were scripted and call 2 has none left');
    expect(first.errorMessage).toContain('"You are the root."');
    expect(first.errorMessage).not.toContain('More detail');
    const second = await call(fake, 'You are the root.');
    expect(second.errorMessage).toContain('call 3 has none left');
    expect(fake.failures()).toHaveLength(2);
  });

  test('an empty script fails the first call', async () => {
    const fake = createFakeModel();
    fake.script([]);
    const msg = await call(fake, undefined);
    expect(msg.errorMessage).toContain('0 response(s) were scripted');
    expect(msg.errorMessage).toContain('(no system prompt)');
  });

  test('a new script replaces the old queue', async () => {
    const fake = createFakeModel();
    fake.script([text('old'), text('old 2')]);
    fake.script([text('new')]);
    expect(fake.pending()).toBe(1);
    expect(textOf(await call(fake, 'sys'))).toBe('new');
  });

  test('factory steps receive the context', async () => {
    const fake = createFakeModel();
    const step: FauxResponseFactory = (context) => text(`saw ${firstLine(context)}`);
    fake.script([step]);
    expect(textOf(await call(fake, 'Root prompt'))).toBe('saw Root prompt');
  });
});

describe('byAgent()', () => {
  const ROOT = 'You are the Triage orchestrator.';
  const CHILD = 'You are investigate_ssfb.';

  test('routes each call by system prompt, whatever the call order', async () => {
    const fake = createFakeModel();
    fake.script([fake.byAgent({ [ROOT]: [text('root 1'), text('root 2')], [CHILD]: [text('child 1')] })]);
    expect(fake.pending()).toBe(3);
    expect(textOf(await call(fake, `${ROOT}\nmethod...`))).toBe('root 1');
    expect(textOf(await call(fake, `${CHILD}\nscope...`))).toBe('child 1');
    expect(textOf(await call(fake, ROOT))).toBe('root 2');
    expect(fake.failures()).toEqual([]);
  });

  test('an unmatched prompt fails naming the first line of the prompt', async () => {
    const fake = createFakeModel();
    fake.script([fake.byAgent({ [ROOT]: [text('root')] })]);
    const msg = await call(fake, '\n  You are code_walker.  \nsecond line');
    expect(msg.stopReason).toBe('error');
    expect(msg.errorMessage).toStartWith(FAKE_MODEL_ERROR_PREFIX);
    expect(msg.errorMessage).toContain('no byAgent route matches the system prompt starting with "You are code_walker."');
    expect(msg.errorMessage).not.toContain('second line');
    expect(fake.failures()).toEqual([msg.errorMessage as string]);
  });

  test('a route with no steps left fails naming the route', async () => {
    const fake = createFakeModel();
    fake.script([fake.byAgent({ [ROOT]: [text('root')], [CHILD]: [text('c1')] })]);
    await call(fake, CHILD);
    const msg = await call(fake, CHILD);
    expect(msg.errorMessage).toContain(`byAgent route "${CHILD}" has no responses left`);
  });

  test('a prompt that matches two routes fails', async () => {
    const fake = createFakeModel();
    fake.script([fake.byAgent({ 'You are': [text('a')], Triage: [text('b')] })]);
    const msg = await call(fake, ROOT);
    expect(msg.errorMessage).toContain('more than one byAgent route matches');
  });

  test('routes compose with plain steps', async () => {
    const fake = createFakeModel();
    fake.script([text('classifier'), fake.byAgent({ [ROOT]: [text('root')] })]);
    expect(fake.pending()).toBe(2);
    expect(textOf(await call(fake, 'You classify.', 'classifier'))).toBe('classifier');
    expect(textOf(await call(fake, ROOT))).toBe('root');
    expect((await call(fake, ROOT)).errorMessage).toContain('the scripted queue is exhausted');
  });

  test('refuses an empty route table or blank keys', () => {
    const fake = createFakeModel();
    expect(() => fake.byAgent({})).toThrow(FakeModelError);
    expect(() => fake.byAgent({ ' ': [text('x')] })).toThrow(/non-empty/);
  });
});

describe('step helpers', () => {
  test('toolCall is a toolUse turn with one call', () => {
    const msg = toolCall('sql_select', { sql: 'select 1' }, { id: 'c1' });
    expect(msg.stopReason).toBe('toolUse');
    expect(msg.content).toEqual([{ type: 'toolCall', id: 'c1', name: 'sql_select', arguments: { sql: 'select 1' } }]);
  });

  test('toolCalls puts several calls in one turn and refuses none', () => {
    const msg = toolCalls([
      { name: 'task', args: { agent: 'investigate_ssfb', prompt: 'a' } },
      { name: 'task', args: { agent: 'investigate_rtl', prompt: 'b' } },
    ]);
    expect(msg.stopReason).toBe('toolUse');
    expect(msg.content.map((b) => (b.type === 'toolCall' ? b.name : b.type))).toEqual(['task', 'task']);
    expect(() => toolCalls([])).toThrow(FakeModelError);
  });

  test('text is a stop turn and finish calls finish_report', () => {
    expect(text('done')).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'done' }] });
    const draft = { status: 'resolved' };
    expect(finish(draft).content).toMatchObject([{ type: 'toolCall', name: 'finish_report', arguments: draft }]);
  });

  test('firstLine trims and caps long lines', () => {
    expect(firstLine({ systemPrompt: `${'x'.repeat(200)}\nnext` })).toBe(`${'x'.repeat(120)}...`);
  });
});

describe('credentials', () => {
  const KEYISH = /(API_KEY|_TOKEN|_SECRET|_KEY)$/;

  test('no provider key is read from the environment', async () => {
    const reads: string[] = [];
    const realEnv = process.env;
    const proxy = new Proxy(realEnv, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') reads.push(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
    process.env = proxy;
    try {
      const fake = createFakeModel();
      fake.install();
      fake.script([text('hi')]);
      await call(fake, 'sys');
    } finally {
      process.env = realEnv;
    }
    expect(reads.filter((k) => KEYISH.test(k))).toEqual([]);
  });

  test('faux auth resolves to an empty credential', async () => {
    const auth = createFakeModel().provider.auth.apiKey;
    expect(await auth?.resolve({} as never)).toEqual({ auth: {} });
  });

  test('the helper source reads no env and no config', () => {
    const source = readFileSync(new URL('./fake-model.ts', import.meta.url), 'utf8');
    for (const banned of ['process.env', 'lookupEnv', 'loadConfig', 'API_KEY']) expect(source).not.toContain(banned);
  });
});
