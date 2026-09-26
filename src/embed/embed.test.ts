import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as bt from 'braintrust';
import { ConfigError } from '../config/errors.ts';
import { redactPersisted, type Persisted } from '../gate/redact.ts';
import { installBraintrust, uninstallBraintrust } from '../tracing/braintrust.ts';
import { makeTestHome } from '../../test/support/home.ts';
import { cosine, hashEmbed, tokenize } from './hash.ts';
import { USAGE_MODEL_PATTERN } from '../types/usage.ts';
import { HASH_MODEL, createEmbedder, type EmbedConfig, type EmbedUsage } from './index.ts';
import { createOllamaClient, ollamaEmbedUrl, ollamaInputTokens } from './ollama.ts';
import { OPENAI_EMBEDDINGS_URL, createOpenAiClient, openAiInputTokens } from './openai.ts';
import { EmbeddingError, parseEmbeddingSpec, type FetchLike } from './spec.ts';

// Built at runtime so no key-shaped literal sits in the source.
const KEY = ['sk', 'test', 'embedkey', '0123456789abcdef'].join('-');

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return Object.assign(fn, { calls });
}

// Response bodies in the shape of each provider's API reference, vectors cut to 4 dims.
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));
const OPENAI_BODY = fixture('openai-embeddings.json');
const OLLAMA_BODY = fixture('ollama-embed.json');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that settles only when its signal aborts. */
function hangingFetch(): FetchLike & { calls: Call[] } {
  return fakeFetch(
    ({ init }) =>
      new Promise<Response>((_, reject) => {
        const signal = init.signal!;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

function cfg(over: { embedding?: string; mock?: boolean; openaiApiKey?: string; ollamaBaseUrl?: string } = {}): EmbedConfig {
  return {
    mock: { enabled: over.mock ?? false },
    models: over.embedding === undefined ? {} : { embedding: over.embedding },
    providers: {
      ...(over.openaiApiKey === undefined ? {} : { openaiApiKey: over.openaiApiKey }),
      ...(over.ollamaBaseUrl === undefined ? {} : { ollamaBaseUrl: over.ollamaBaseUrl }),
    },
    budgets: { httpTimeoutMs: 30_000 },
  };
}

const persisted = (...texts: string[]): Persisted<string>[] => texts.map((t) => redactPersisted(t));

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('parseEmbeddingSpec', () => {
  test("'ollama/nomic-embed-text' parses", () => {
    expect(parseEmbeddingSpec('ollama/nomic-embed-text')).toEqual({ provider: 'ollama', model: 'nomic-embed-text' });
    expect(parseEmbeddingSpec(' openai/text-embedding-3-small ')).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
  });

  test('a model name may contain slashes and tags', () => {
    expect(parseEmbeddingSpec('ollama/library/bge-m3:latest')).toEqual({ provider: 'ollama', model: 'library/bge-m3:latest' });
  });

  test("'' and whitespace disable embeddings", () => {
    expect(parseEmbeddingSpec('')).toBeNull();
    expect(parseEmbeddingSpec('   ')).toBeNull();
    expect(parseEmbeddingSpec(undefined)).toBeNull();
  });

  test.each(['openrouter/x', 'OpenRouter/openai/text-embedding-3-small', 'anthropic/x', 'voyage/voyage-3', 'x'])(
    '%p is refused naming MODEL_EMBEDDING only',
    (value) => {
      const err = configError(() => parseEmbeddingSpec(value));
      expect(err.keys).toEqual(['MODEL_EMBEDDING']);
      expect(err.message).toContain('MODEL_EMBEDDING');
      expect(err.message).not.toContain(value);
    },
  );

  test("'ollama/' and '/model' are refused", () => {
    expect(configError(() => parseEmbeddingSpec('ollama/')).keys).toEqual(['MODEL_EMBEDDING']);
    expect(configError(() => parseEmbeddingSpec('/nomic')).keys).toEqual(['MODEL_EMBEDDING']);
  });
});

describe('createEmbedder', () => {
  test('blank MODEL_EMBEDDING returns null and does not need provider keys', () => {
    const fetch = fakeFetch(() => json({}));
    expect(createEmbedder(cfg(), { fetch })).toBeNull();
    expect(createEmbedder(cfg({ embedding: '' }), { fetch })).toBeNull();
    expect(createEmbedder(cfg({ embedding: '', mock: true }), { fetch, forbidRemote: true })).toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });

  test('works on a real loaded config from a test home', () => {
    const blank = makeTestHome();
    try {
      expect(createEmbedder(blank.config, { fetch: fakeFetch(() => json({})) })).toBeNull();
    } finally {
      blank.cleanup();
    }
    const set = makeTestHome({ overrides: { MODEL_EMBEDDING: 'ollama/nomic-embed-text' } });
    try {
      expect(createEmbedder(set.config, { fetch: fakeFetch(() => json({})) })?.model).toBe(HASH_MODEL);
    } finally {
      set.cleanup();
    }
  });

  test('refused providers fail in mock mode too', () => {
    const fetch = fakeFetch(() => json({}));
    for (const embedding of ['openrouter/x', 'anthropic/x']) {
      const err = configError(() => createEmbedder(cfg({ embedding, mock: true }), { fetch }));
      expect(err.keys).toEqual(['MODEL_EMBEDDING']);
    }
  });

  test('ollama without OLLAMA_BASE_URL and openai without a key are refused by key name', () => {
    const fetch = fakeFetch(() => json({}));
    expect(configError(() => createEmbedder(cfg({ embedding: 'ollama/nomic-embed-text' }), { fetch })).keys).toEqual([
      'OLLAMA_BASE_URL',
    ]);
    expect(
      configError(() => createEmbedder(cfg({ embedding: 'openai/text-embedding-3-small', openaiApiKey: ' ' }), { fetch }))
        .keys,
    ).toEqual(['OPENAI_API_KEY']);
  });

  test('model names the vector space', () => {
    const fetch = fakeFetch(() => json({}));
    const e = createEmbedder(cfg({ embedding: 'ollama/nomic-embed-text', ollamaBaseUrl: 'http://127.0.0.1:11434' }), { fetch });
    expect(e?.model).toBe('ollama/nomic-embed-text');
  });

  test('embed() rejects non-Persisted input at compile time and at run time', async () => {
    const e = createEmbedder(cfg({ embedding: 'ollama/x', mock: true }), { fetch: fakeFetch(() => json({})) })!;
    // @ts-expect-error a plain string is not Persisted<string>
    const plain = () => e.embed(['hello']);
    // @ts-expect-error a Persisted object is not Persisted<string>
    const wrongInner = () => e.embed([redactPersisted({ text: 'hello' })]);
    expect(await rejection(plain())).toBeInstanceOf(TypeError);
    expect(await rejection(wrongInner())).toBeInstanceOf(TypeError);
    expect(await e.embed(persisted('hello'))).toHaveLength(1);
  });

  test('embed() hands the redacted text, not the raw text, to the provider', async () => {
    const fetch = fakeFetch(() => json({ embeddings: [[0.1, 0.2]] }));
    const e = createEmbedder(cfg({ embedding: 'ollama/x', ollamaBaseUrl: 'http://127.0.0.1:11434' }), { fetch })!;
    await e.embed([redactPersisted('mail a.person@example.com now')]);
    const body = JSON.parse(String(fetch.calls[0]!.init.body)) as { input: string[] };
    expect(body.input[0]).not.toContain('a.person@example.com');
  });
});

describe('mock mode', () => {
  const specs = ['ollama/nomic-embed-text', 'openai/text-embedding-3-small'];

  test.each(specs)('%p uses the hash embedder and never calls fetch', async (embedding) => {
    const fetch = fakeFetch(() => json({}));
    const e = createEmbedder(cfg({ embedding, mock: true, openaiApiKey: KEY, ollamaBaseUrl: 'http://127.0.0.1:11434' }), {
      fetch,
    })!;
    expect(e.model).toBe(HASH_MODEL);
    const [a, b, c] = await e.embed(persisted('payment stuck at bank', 'payment stuck at bank', 'kyc form rejected'));
    expect(a).toEqual(b!);
    expect(a).not.toEqual(c!);
    expect(fetch.calls).toHaveLength(0);
  });

  test('works without any provider keys', async () => {
    const fetch = fakeFetch(() => json({}));
    const e = createEmbedder(cfg({ embedding: 'openai/text-embedding-3-small', mock: true }), { fetch })!;
    expect(await e.embed(persisted('x'))).toHaveLength(1);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('hash embedder', () => {
  test('is deterministic, normalised and case-insensitive', () => {
    const v = hashEmbed('Refund Failed for UPI');
    expect(v).toEqual(hashEmbed('refund failed for upi'));
    expect(v).toHaveLength(512);
    expect(Math.hypot(...v)).toBeCloseTo(1, 10);
  });

  test('similar word sets score a higher cosine than disjoint ones', () => {
    const q = hashEmbed('upi payment stuck pending at partner bank');
    const similar = hashEmbed('payment stuck pending at the bank for upi transfer');
    const disjoint = hashEmbed('kyc document rejected passport expired');
    expect(cosine(q, similar)).toBeGreaterThan(0.6);
    expect(cosine(q, similar)).toBeGreaterThan(cosine(q, disjoint) + 0.4);
  });

  test('text with no words gives the zero vector and cosine 0', () => {
    const z = hashEmbed(' -- !! ');
    expect(z.every((x) => x === 0)).toBe(true);
    expect(cosine(z, hashEmbed('hello'))).toBe(0);
    expect(tokenize('Ab-12 cd')).toEqual(['ab', '12', 'cd']);
  });
});

describe('ollama client', () => {
  test('POSTs {model, input[]} to OLLAMA_BASE_URL/api/embed and parses vectors', async () => {
    const fetch = fakeFetch(() => json({ model: 'nomic-embed-text', embeddings: [[1, 2, 3], [4, 5, 6]] }));
    const client = createOllamaClient({ baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text', fetch, timeoutMs: 1000 });
    expect((await client(['a', 'b'])).vectors).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(fetch.calls).toHaveLength(1);
    const { url, init } = fetch.calls[0]!;
    expect(url).toBe('http://127.0.0.1:11434/api/embed');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  test('drops a trailing slash and the OpenAI-compatible /v1 suffix from the base URL', () => {
    expect(ollamaEmbedUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/api/embed');
    expect(ollamaEmbedUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/api/embed');
    expect(ollamaEmbedUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434/api/embed');
  });

  test('empty input makes no call', async () => {
    const fetch = fakeFetch(() => json({}));
    const client = createOllamaClient({ baseUrl: 'http://127.0.0.1:11434', model: 'm', fetch, timeoutMs: 1000 });
    expect(await client([])).toEqual({ vectors: [], inputTokens: 0 });
    expect(fetch.calls).toHaveLength(0);
  });

  test.each([
    ['no embeddings field', { model: 'm' }],
    ['wrong count', { embeddings: [[1, 2]] }],
    ['non-number entry', { embeddings: [[1, 'x'], [1, 2]] }],
    ['mixed dimensions', { embeddings: [[1, 2], [1, 2, 3]] }],
    ['empty vector', { embeddings: [[], []] }],
  ])('a malformed response (%s) is an EmbeddingError', async (_, body) => {
    const client = createOllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'm',
      fetch: fakeFetch(() => json(body)),
      timeoutMs: 1000,
    });
    const err = await rejection(client(['a', 'b']));
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).reason).toBe('malformed');
  });

  test('invalid JSON is an EmbeddingError', async () => {
    const client = createOllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'm',
      fetch: fakeFetch(() => new Response('not json', { status: 200 })),
      timeoutMs: 1000,
    });
    expect(((await rejection(client(['a']))) as EmbeddingError).reason).toBe('malformed');
  });
});

describe('openai client', () => {
  test('sends the Authorization header and {model, input[]} to /v1/embeddings', async () => {
    const fetch = fakeFetch(() =>
      json({
        object: 'list',
        data: [
          { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
          { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
        ],
      }),
    );
    const client = createOpenAiClient({ apiKey: KEY, model: 'text-embedding-3-small', fetch, timeoutMs: 1000 });
    expect((await client(['first', 'second'])).vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const { url, init } = fetch.calls[0]!;
    expect(url).toBe(OPENAI_EMBEDDINGS_URL);
    expect(new URL(url).pathname).toBe('/v1/embeddings');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({ model: 'text-embedding-3-small', input: ['first', 'second'] });
    expect(url).not.toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);
  });

  test('the key is absent from thrown error messages', async () => {
    const failures: FetchLike[] = [
      async () => {
        throw new Error(`socket closed while sending Bearer ${KEY}`);
      },
      async () => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401),
      async () => new Response(`garbage ${KEY}`, { status: 200 }),
      async () => json({ data: [{ index: 0, embedding: KEY }] }),
    ];
    for (const fetch of failures) {
      const client = createOpenAiClient({ apiKey: KEY, model: 'm', fetch, timeoutMs: 1000 });
      const err = (await rejection(client(['a']))) as Error;
      expect(err).toBeInstanceOf(EmbeddingError);
      expect(err.message).not.toContain(KEY);
      expect(err.stack ?? '').not.toContain(KEY);
      expect(JSON.stringify(err)).not.toContain(KEY);
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  test('duplicate or out-of-range indexes are malformed', async () => {
    for (const data of [
      [
        { index: 0, embedding: [1] },
        { index: 0, embedding: [2] },
      ],
      [
        { index: 0, embedding: [1] },
        { index: 5, embedding: [2] },
      ],
    ]) {
      const client = createOpenAiClient({ apiKey: KEY, model: 'm', fetch: fakeFetch(() => json({ data })), timeoutMs: 1000 });
      expect(((await rejection(client(['a', 'b']))) as EmbeddingError).reason).toBe('malformed');
    }
  });
});

describe('failures', () => {
  test('a non-2xx response is an EmbeddingError with the status and no body echo', async () => {
    for (const status of [400, 401, 429, 500, 503]) {
      const body = { error: { message: `bad key ${KEY}` } };
      const openai = createOpenAiClient({ apiKey: KEY, model: 'm', fetch: fakeFetch(() => json(body, status)), timeoutMs: 1000 });
      const err = (await rejection(openai(['a']))) as EmbeddingError;
      expect(err).toBeInstanceOf(EmbeddingError);
      expect(err.status).toBe(status);
      expect(err.reason).toBe('status');
      expect(err.message).toBe(`openai embeddings request failed: status ${status}`);
      expect(err.message).not.toContain(KEY);
      expect(err.message).not.toContain('bad key');

      const ollama = createOllamaClient({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'm',
        fetch: fakeFetch(() => json({ error: 'model not found' }, status)),
        timeoutMs: 1000,
      });
      const oerr = (await rejection(ollama(['a']))) as EmbeddingError;
      expect(oerr.status).toBe(status);
      expect(oerr.message).not.toContain('model not found');
    }
  });

  test('the error message does not echo the base URL', async () => {
    const baseUrl = 'http://someone:hunter2@127.0.0.1:11434';
    const client = createOllamaClient({
      baseUrl,
      model: 'm',
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED ${baseUrl}`);
      },
      timeoutMs: 1000,
    });
    const err = (await rejection(client(['a']))) as EmbeddingError;
    expect(err.reason).toBe('network');
    expect(err.message).not.toContain('hunter2');
  });

  test('the abort signal cancels the fake fetch', async () => {
    const fetch = hangingFetch();
    const client = createOpenAiClient({ apiKey: KEY, model: 'm', fetch, timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = client(['a'], { signal: controller.signal });
    await Promise.resolve();
    expect(fetch.calls).toHaveLength(1);
    const reason = new Error('caller gave up');
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
    expect(fetch.calls[0]!.init.signal!.aborted).toBe(true);
  });

  test('an already-aborted signal makes no call', async () => {
    const fetch = hangingFetch();
    const client = createOllamaClient({ baseUrl: 'http://127.0.0.1:11434', model: 'm', fetch, timeoutMs: 60_000 });
    const controller = new AbortController();
    controller.abort();
    const err = (await rejection(client(['a'], { signal: controller.signal }))) as Error;
    expect(err.name).toBe('AbortError');
    expect(fetch.calls).toHaveLength(0);
  });

  test('the signal passes through createEmbedder', async () => {
    const fetch = hangingFetch();
    const e = createEmbedder(cfg({ embedding: 'ollama/m', ollamaBaseUrl: 'http://127.0.0.1:11434' }), { fetch, timeoutMs: 60_000 })!;
    const controller = new AbortController();
    const pending = e.embed(persisted('a'), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect(((await rejection(pending)) as Error).name).toBe('AbortError');
    expect(fetch.calls[0]!.init.signal!.aborted).toBe(true);
  });

  test('the timeout aborts the fetch and throws EmbeddingError timeout', async () => {
    const fetch = hangingFetch();
    const client = createOllamaClient({ baseUrl: 'http://127.0.0.1:11434', model: 'm', fetch, timeoutMs: 20 });
    const err = (await rejection(client(['a']))) as EmbeddingError;
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.reason).toBe('timeout');
    expect(fetch.calls[0]!.init.signal!.aborted).toBe(true);
  });

  test('createEmbedder uses TRIAGE_HTTP_TIMEOUT_MS by default', async () => {
    const fetch = hangingFetch();
    const config = { ...cfg({ embedding: 'ollama/m', ollamaBaseUrl: 'http://127.0.0.1:11434' }), budgets: { httpTimeoutMs: 20 } };
    const e = createEmbedder(config, { fetch })!;
    expect(((await rejection(e.embed(persisted('a')))) as EmbeddingError).reason).toBe('timeout');
  });
});

describe('forbidRemote', () => {
  test.each([false, true])('refuses the openai spec (mock mode %p) naming MODEL_EMBEDDING', (mock) => {
    const fetch = fakeFetch(() => json({}));
    const err = configError(() =>
      createEmbedder(cfg({ embedding: 'openai/text-embedding-3-small', mock, openaiApiKey: KEY }), { fetch, forbidRemote: true }),
    );
    expect(err.keys).toEqual(['MODEL_EMBEDDING']);
    expect(err.message).not.toContain('text-embedding-3-small');
    expect(fetch.calls).toHaveLength(0);
  });

  test('allows ollama', async () => {
    const fetch = fakeFetch(() => json({ embeddings: [[1, 0]] }));
    const live = createEmbedder(cfg({ embedding: 'ollama/nomic-embed-text', ollamaBaseUrl: 'http://127.0.0.1:11434' }), {
      fetch,
      forbidRemote: true,
    });
    expect(live?.model).toBe('ollama/nomic-embed-text');
    expect(await live!.embed(persisted('a'))).toEqual([[1, 0]]);
    const mocked = createEmbedder(cfg({ embedding: 'ollama/nomic-embed-text', mock: true }), { fetch, forbidRemote: true });
    expect(mocked?.model).toBe(HASH_MODEL);
  });

  test('without forbidRemote openai is allowed', () => {
    const e = createEmbedder(cfg({ embedding: 'openai/text-embedding-3-small', openaiApiKey: KEY }), {
      fetch: fakeFetch(() => json({})),
    });
    expect(e?.model).toBe('openai/text-embedding-3-small');
  });
});

describe('usage', () => {
  const OLLAMA_URL = 'http://127.0.0.1:11434';

  function recorder(): { onUsage: (u: EmbedUsage) => void; seen: EmbedUsage[] } {
    const seen: EmbedUsage[] = [];
    return { onUsage: (u) => seen.push(u), seen };
  }

  const openaiEmbedder = (fetch: FetchLike, embedding = 'openai/text-embedding-3-small') =>
    createEmbedder(cfg({ embedding, openaiApiKey: KEY }), { fetch, timeoutMs: 1000 })!;
  const ollamaEmbedder = (fetch: FetchLike) =>
    createEmbedder(cfg({ embedding: 'ollama/nomic-embed-text', ollamaBaseUrl: OLLAMA_URL }), { fetch, timeoutMs: 1000 })!;

  test('the openai client reads usage.prompt_tokens from the response', async () => {
    const client = createOpenAiClient({ apiKey: KEY, model: 'm', fetch: fakeFetch(() => json(OPENAI_BODY)), timeoutMs: 1000 });
    const out = await client(['a', 'b']);
    expect(out.inputTokens).toBe(17);
    expect(out.vectors).toHaveLength(2);
  });

  test('the ollama client reads prompt_eval_count from the response', async () => {
    const client = createOllamaClient({ baseUrl: OLLAMA_URL, model: 'm', fetch: fakeFetch(() => json(OLLAMA_BODY)), timeoutMs: 1000 });
    const out = await client(['a', 'b']);
    expect(out.inputTokens).toBe(13);
    expect(out.vectors).toHaveLength(2);
  });

  test('onUsage hears the spec and the provider tokens once per call', async () => {
    const openai = recorder();
    const vectors = await openaiEmbedder(fakeFetch(() => json(OPENAI_BODY))).embed(persisted('a', 'b'), openai);
    expect(vectors).toHaveLength(2);
    expect(openai.seen).toEqual([{ model: 'openai/text-embedding-3-small', inputTokens: 17, failed: false }]);

    const ollama = recorder();
    await ollamaEmbedder(fakeFetch(() => json(OLLAMA_BODY))).embed(persisted('a', 'b'), ollama);
    expect(ollama.seen).toEqual([{ model: 'ollama/nomic-embed-text', inputTokens: 13, failed: false }]);
  });

  test('the reported model is the normalised spec and fits the usage row pattern', async () => {
    const r = recorder();
    await openaiEmbedder(fakeFetch(() => json(OPENAI_BODY)), ' OpenAI/text-embedding-3-small ').embed(persisted('a', 'b'), r);
    expect(r.seen[0]!.model).toBe('openai/text-embedding-3-small');
    expect(r.seen[0]!.model).toMatch(USAGE_MODEL_PATTERN);
  });

  test('a response without a token count gives 0 tokens and usageMissing', async () => {
    const { usage: _, ...openaiNoUsage } = OPENAI_BODY;
    const { prompt_eval_count: __, ...ollamaNoCount } = OLLAMA_BODY;
    const openai = recorder();
    await openaiEmbedder(fakeFetch(() => json(openaiNoUsage))).embed(persisted('a', 'b'), openai);
    expect(openai.seen).toEqual([{ model: 'openai/text-embedding-3-small', inputTokens: 0, failed: false, usageMissing: true }]);
    const ollama = recorder();
    await ollamaEmbedder(fakeFetch(() => json(ollamaNoCount))).embed(persisted('a', 'b'), ollama);
    expect(ollama.seen).toEqual([{ model: 'ollama/nomic-embed-text', inputTokens: 0, failed: false, usageMissing: true }]);
  });

  test.each([null, -1, 1.5, '17', Number.MAX_VALUE])('a token count of %p is treated as missing', (count) => {
    expect(openAiInputTokens({ ...OPENAI_BODY, usage: { prompt_tokens: count } })).toBeNull();
    expect(ollamaInputTokens({ ...OLLAMA_BODY, prompt_eval_count: count })).toBeNull();
  });

  test('a count of 0 is reported, not missing', () => {
    expect(openAiInputTokens({ usage: { prompt_tokens: 0 } })).toBe(0);
    expect(ollamaInputTokens({ prompt_eval_count: 0 })).toBe(0);
    expect(openAiInputTokens({ usage: null })).toBeNull();
    expect(openAiInputTokens(null)).toBeNull();
  });

  test.each(['ollama/nomic-embed-text', 'openai/text-embedding-3-small'])(
    'mock mode (%p) reports the spec with 0 tokens and never calls fetch',
    async (embedding) => {
      const fetch = fakeFetch(() => json(OPENAI_BODY));
      const e = createEmbedder(cfg({ embedding, mock: true }), { fetch })!;
      const r = recorder();
      await e.embed(persisted('a', 'b'), r);
      expect(e.model).toBe(HASH_MODEL);
      expect(r.seen).toEqual([{ model: embedding, inputTokens: 0, failed: false }]);
      expect(fetch.calls).toHaveLength(0);
    },
  );

  test('an EmbeddingError is reported as a failed call and rethrown', async () => {
    const r = recorder();
    const err = await rejection(openaiEmbedder(fakeFetch(() => json({}, 429))).embed(persisted('a'), r));
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).status).toBe(429);
    expect(r.seen).toEqual([{ model: 'openai/text-embedding-3-small', inputTokens: 0, failed: true }]);

    const malformed = recorder();
    const merr = await rejection(ollamaEmbedder(fakeFetch(() => json({ prompt_eval_count: 9 }))).embed(persisted('a'), malformed));
    expect((merr as EmbeddingError).reason).toBe('malformed');
    expect(malformed.seen).toEqual([{ model: 'ollama/nomic-embed-text', inputTokens: 0, failed: true }]);
  });

  test('a caller abort is reported as a failed call and rethrows the reason', async () => {
    const fetch = hangingFetch();
    const r = recorder();
    const controller = new AbortController();
    const pending = ollamaEmbedder(fetch).embed(persisted('a'), { signal: controller.signal, onUsage: r.onUsage });
    await Promise.resolve();
    const reason = new Error('caller gave up');
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
    expect(r.seen).toEqual([{ model: 'ollama/nomic-embed-text', inputTokens: 0, failed: true }]);
  });

  test('empty input and non-Persisted input are not reported', async () => {
    const fetch = fakeFetch(() => json(OLLAMA_BODY));
    const e = ollamaEmbedder(fetch);
    const r = recorder();
    expect(await e.embed([], r)).toEqual([]);
    // @ts-expect-error a plain string is not Persisted<string>
    expect(await rejection(e.embed(['hello'], r))).toBeInstanceOf(TypeError);
    expect(r.seen).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });

  test('a throwing onUsage does not change the result or the error', async () => {
    const onUsage = () => {
      throw new Error('sink broke');
    };
    expect(await ollamaEmbedder(fakeFetch(() => json(OLLAMA_BODY))).embed(persisted('a', 'b'), { onUsage })).toHaveLength(2);
    const err = await rejection(ollamaEmbedder(fakeFetch(() => json({}, 500))).embed(persisted('a'), { onUsage }));
    expect((err as EmbeddingError).status).toBe(500);
  });

  test('embed() without onUsage behaves as before', async () => {
    expect(await ollamaEmbedder(fakeFetch(() => json(OLLAMA_BODY))).embed(persisted('a', 'b'))).toEqual(
      OLLAMA_BODY['embeddings'] as number[][],
    );
  });
});

// ---------------------------------------------------------------- tracing (D82)

// Braintrust's in-memory background logger: nothing leaves the process. The
// texts are synthetic.
describe('tracing', () => {
  const T = bt._exportsForTestingOnly;
  // A run id with a 6+ digit run, which the persisted profile would mask.
  const RUN = '01M3EN7034701234ABCDEFGHJK';
  const TEXTS = ['welcome letter never arrived for Asha Testuser', 'second text'];
  const TRACE = { runId: RUN, purpose: 'prior_cases' };
  type Row = Record<string, any>;
  let memory: ReturnType<typeof T.useTestBackgroundLogger>;
  const savedHome = process.env.TRIAGE_HOME;

  const openai = (fetch: FetchLike) =>
    createEmbedder(cfg({ embedding: 'openai/text-embedding-3-small', openaiApiKey: KEY }), { fetch })!;

  async function tracingOn(): Promise<void> {
    await installBraintrust(
      { tracing: { enabled: true, apiKey: 'test-braintrust-key', projectName: 'triage-app', content: 'metadata' } },
      { load: async () => bt, instrument: () => async () => undefined, names: () => [], projectId: 'test-project-id' },
    );
  }

  beforeAll(async () => {
    // The traced path loads the pricer, which imports models.ts; that loads
    // config at import, so a home exported in the shell must not be read.
    delete process.env.TRIAGE_HOME;
    await import('../usage/price.ts');
    await T.simulateLoginForTests();
  });
  beforeEach(() => {
    memory = T.useTestBackgroundLogger();
  });
  afterEach(async () => {
    await uninstallBraintrust();
    T.clearTestBackgroundLogger();
  });
  afterAll(() => {
    T.simulateLogoutForTests();
    if (savedHome !== undefined) process.env.TRIAGE_HOME = savedHome;
  });

  test('with tracing off a traced call sends the same request, returns the same vectors and records nothing', async () => {
    const plain = fakeFetch(() => json(OPENAI_BODY));
    const traced = fakeFetch(() => json(OPENAI_BODY));
    const usage: EmbedUsage[] = [];
    const a = await openai(plain).embed(persisted(...TEXTS));
    const b = await openai(traced).embed(persisted(...TEXTS), { trace: TRACE, onUsage: (u) => void usage.push(u) });
    expect(b).toEqual(a);
    expect(traced.calls.map((c) => c.init.body)).toEqual(plain.calls.map((c) => c.init.body));
    expect(usage).toEqual([{ model: 'openai/text-embedding-3-small', inputTokens: 17, failed: false }]);
    expect(await memory.drain()).toEqual([]);
  });

  test("a traced call is one llm span with run id, tokens and cost, and no text in 'metadata' mode", async () => {
    await tracingOn();
    const vectors = await openai(fakeFetch(() => json(OPENAI_BODY))).embed(persisted(...TEXTS), { trace: TRACE });
    expect(vectors).toHaveLength(2);
    const all = (await memory.drain()) as Row[];
    expect(all).toHaveLength(1);
    const row = all[0] as Row;
    expect(row.span_attributes).toMatchObject({ name: 'embed:openai/text-embedding-3-small', type: 'llm' });
    expect(row.metadata).toMatchObject({ kind: 'embed', model: 'openai/text-embedding-3-small', run_id: RUN, purpose: 'prior_cases', texts: 2 });
    expect(row.metrics).toMatchObject({ prompt_tokens: 17, tokens: 17 });
    // EMBEDDING_PRICES: 0.02 USD per million input tokens.
    expect(row.metrics.estimated_cost).toBeCloseTo((17 * 0.02) / 1_000_000, 12);
    const sent = JSON.stringify(row);
    for (const marker of ['welcome letter', 'second text']) expect(sent).not.toContain(marker);
  });

  test('a call without the trace option is not traced, with tracing on', async () => {
    await tracingOn();
    await openai(fakeFetch(() => json(OPENAI_BODY))).embed(persisted(...TEXTS));
    await openai(fakeFetch(() => json(OPENAI_BODY))).embed([], { trace: TRACE });
    expect(await memory.drain()).toEqual([]);
  });

  test('a failed call is rethrown as it was and its span holds the error class only', async () => {
    await tracingOn();
    const usage: EmbedUsage[] = [];
    const err = await rejection(
      openai(fakeFetch(() => json({ error: 'nope' }, 500))).embed(persisted(...TEXTS), { trace: TRACE, onUsage: (u) => void usage.push(u) }),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(usage).toEqual([{ model: 'openai/text-embedding-3-small', inputTokens: 0, failed: true }]);
    const row = (await memory.drain())[0] as Row;
    expect(row.error).toBe('EmbeddingError');
    expect(row.metadata.is_error).toBe(true);
  });

  test('mock mode traces the hash embedder at no cost', async () => {
    await tracingOn();
    const e = createEmbedder(cfg({ embedding: 'openai/text-embedding-3-small', mock: true }), { fetch: fakeFetch(() => json({})) })!;
    await e.embed(persisted(...TEXTS), { trace: TRACE });
    const row = (await memory.drain())[0] as Row;
    expect(row.span_attributes.name).toBe(`embed:${HASH_MODEL}`);
    expect(row.metrics.estimated_cost).toBe(0);
  });
});
