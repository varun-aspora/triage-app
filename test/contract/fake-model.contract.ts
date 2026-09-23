// Spike for the fake model provider (T03.6). Boots Flue in process with the
// test-only echo agent and the faux provider, and proves:
// - a scripted tool call and a final text round-trip through start() and
//   install() with no network request;
// - a delegate started through the task tool draws its turns from the same
//   faux queue as the root agent (the finding is written in the header of
//   src/mock/fake-model.ts);
// - byAgent() routes the parent's and the delegate's turns by system prompt;
// - an exhausted script fails the run with the helper's message.

import http from 'node:http';
import https from 'node:https';
import type { FauxResponseFactory } from '@earendil-works/pi-ai';
import { AgentRunError, init } from '@flue/runtime';
import { hasProvider } from '@flue/runtime/internal';
import { start, type Flue } from '@flue/runtime/node';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeModel, FAKE_MODEL_ERROR_PREFIX, text, toolCall, type FakeStep } from '../../src/mock/fake-model.ts';
import { assertNoIoGuardInstalled } from '../support/no-io-guard.ts';
import { Echo, ECHO_PROMPT, echoCalls, HELPER_PROMPT } from '../fixtures/agents/echo-agent.ts';

assertNoIoGuardInstalled();

const fake = createFakeModel();
const fetchSpy = vi.spyOn(globalThis, 'fetch');
const httpSpy = vi.spyOn(http, 'request');
const httpsSpy = vi.spyOn(https, 'request');
let flue: Flue;

beforeAll(async () => {
  fake.install();
  // No providers option: the default built-ins register around faux (see the
  // header of fake-model.ts). env is empty so no provider key can be picked up.
  flue = await start({ agents: [Echo], env: {} });
});

afterAll(async () => {
  await flue?.stop();
});

beforeEach(() => {
  echoCalls.length = 0;
});

type Seen = { call: number; system: string };

// Wraps each step so the test can see which agent's prompt drew it.
function recording(steps: readonly FakeStep[], seen: Seen[]): FakeStep[] {
  return steps.map((step): FauxResponseFactory => (context, options, state, model) => {
    seen.push({ call: state.callCount, system: context.systemPrompt ?? '' });
    return typeof step === 'function' ? step(context, options, state, model) : step;
  });
}

async function run(message: string) {
  const agent = init(Echo);
  const receipt = await agent.dispatch(message);
  const tools: string[] = [];
  const reply = await agent.read(receipt, {
    onEvent: (chunk) => {
      if (chunk.type === 'tool-input') tools.push(chunk.toolName);
    },
  });
  return { reply, tools };
}

describe('fake model under Flue start()', () => {
  test('install() keeps the built-in providers start() registered', () => {
    expect(hasProvider('faux')).toBe(true);
    expect(hasProvider('anthropic')).toBe(true);
  });

  test('echo agent: one tool call, then a final text, from the script', async () => {
    const seen: Seen[] = [];
    fake.script(recording([toolCall('echo', { text: 'ping' }), text('echoed ping')], seen));

    const { reply, tools } = await run('Echo ping.');

    expect(tools).toEqual(['echo']);
    expect(echoCalls).toEqual(['ping']);
    expect(reply.text).toBe('echoed ping');
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.system.includes(ECHO_PROMPT))).toBe(true);
    expect(fake.pending()).toBe(0);
    expect(fake.failures()).toEqual([]);
  });

  test('delegate turns come from the same queue, in call order (spike)', async () => {
    const seen: Seen[] = [];
    fake.script(
      recording(
        [
          toolCall('task', { agent: 'echo_helper', prompt: 'Say hello.' }),
          text('hello from the helper'),
          text('the helper said hello'),
        ],
        seen,
      ),
    );

    const { reply, tools } = await run('Ask the helper to say hello.');

    expect(tools).toContain('task');
    expect(reply.text).toBe('the helper said hello');
    expect(seen).toHaveLength(3);
    // Parent, then the delegate, then the parent again: one shared queue.
    expect(seen[0]?.system).toContain(ECHO_PROMPT);
    expect(seen[1]?.system).toContain(HELPER_PROMPT);
    expect(seen[1]?.system).not.toContain(ECHO_PROMPT);
    expect(seen[2]?.system).toContain(ECHO_PROMPT);
    expect(fake.failures()).toEqual([]);
  });

  test('byAgent routes parent and delegate turns by system prompt', async () => {
    fake.script([
      fake.byAgent({
        [ECHO_PROMPT]: [
          toolCall('task', { agent: 'echo_helper', prompt: 'Echo pong.' }),
          text('parent done'),
        ],
        [HELPER_PROMPT]: [text('pong')],
      }),
    ]);

    const { reply } = await run('Delegate an echo.');

    expect(reply.text).toBe('parent done');
    expect(fake.pending()).toBe(0);
    expect(fake.failures()).toEqual([]);
  });

  test('an exhausted script fails the run with the helper message', async () => {
    fake.script([toolCall('echo', { text: 'once' })]);

    const err = await run('Echo once.').then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AgentRunError);
    expect(fake.failures()[0]).toContain(`${FAKE_MODEL_ERROR_PREFIX} the scripted queue is exhausted`);
    expect(fake.failures()[0]).toContain(ECHO_PROMPT.split('\n')[0]);
  });

  test('no network request was made', () => {
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(httpSpy).toHaveBeenCalledTimes(0);
    expect(httpsSpy).toHaveBeenCalledTimes(0);
  });
});
