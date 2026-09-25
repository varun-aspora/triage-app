// triage models refresh, run through buildProgram and runCli with a test home,
// fake io and a fake fetch.

import { afterEach, describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { PI_AI_CATALOG_BASE, type FetchFn } from '../../model-catalog.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { createModelsRefreshCommand } from './models-refresh.command.ts';

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

const NEW_ID = 'gpt-t9-cli';

function fakeFetch(calls: string[], status = 200): FetchFn {
  return async (url) => {
    calls.push(url);
    const catalog = {
      'openai-responses': {
        [NEW_ID]: {
          id: NEW_ID,
          name: NEW_ID,
          api: 'openai-responses',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 272000,
          maxTokens: 128000,
        },
      },
    };
    return new Response(JSON.stringify(url.endsWith('openai.json') ? catalog : {}), { status });
  };
}

async function cli(argv: string[], fetch: FetchFn) {
  const h = makeTestHome();
  homes.push(h);
  let out = '';
  let err = '';
  const ctx: CliContext = {
    config: () => h.config,
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from([]),
      isTTY: false,
    },
    deps: {},
  };
  const code = await runCli(buildProgram([createModelsRefreshCommand({ fetch })], ctx), ['models', 'refresh', ...argv]);
  return { code, out, err, h };
}

describe('triage models refresh', () => {
  test('is in the generated command list', () => {
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('models refresh');
  });

  test('refreshes both providers and lists the added models', async () => {
    const calls: string[] = [];
    const r = await cli([], fakeFetch(calls));
    expect(r.code).toBe(EXIT.OK);
    expect(calls.sort()).toEqual([`${PI_AI_CATALOG_BASE}anthropic.json`, `${PI_AI_CATALOG_BASE}openai.json`]);
    expect(r.out).toBe(`anthropic: no models beyond the installed pi-ai\nopenai: ${NEW_ID}\n`);
  });

  test('--provider and --json', async () => {
    const calls: string[] = [];
    const r = await cli(['--provider', 'openai', '--json'], fakeFetch(calls));
    expect(r.code).toBe(EXIT.OK);
    expect(calls).toEqual([`${PI_AI_CATALOG_BASE}openai.json`]);
    const body = JSON.parse(r.out);
    expect(body.results).toEqual([{ provider: 'openai', ok: true, added: [NEW_ID] }]);
    expect(body.cache_dir.endsWith('cache/models')).toBe(true);
  });

  test('a failed fetch exits 1', async () => {
    const r = await cli(['--provider', 'openai'], fakeFetch([], 500));
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.out).toBe('openai: failed: catalog fetch for openai answered HTTP 500\n');
  });

  test('an unknown provider is a usage error', async () => {
    const calls: string[] = [];
    const r = await cli(['--provider', 'ollama'], fakeFetch(calls));
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain('--provider must be one of anthropic, openai');
    expect(calls).toEqual([]);
  });
});
