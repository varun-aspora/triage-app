// HTTP server end to end (D50). runServer() from src/server/main.ts with its
// real deps: prepareServer, bootRuntime() (Flue's start() with the src/db.ts
// adapter) and @hono/node-server on a loopback port. A triage goes in through
// POST /triage and is polled through GET /triage/:run_id until it settles,
// so the route handlers run inside the runtime runServer started.
//
// The home is an eval home with a token and a free port written into its
// .env: mock mode is strict, every credential is blank and the models are
// faux, registered in this process. The only network use is this test
// talking to its own server over loopback.
//
// The served classifier has no completion for faux (only the eval driver
// injects one), so it fails before any call and the policy falls back to
// strong. The script therefore has no classifier turn, and the report draft
// is for strong.

import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadCases } from '../../src/evals/case-schema.ts';
import { fauxScript, type FauxScript } from '../../src/evals/contract/faux-script.ts';
import { resetRuntimeForTests } from '../../src/ingress/runtime.ts';
import { createFakeModel, finish, text, toolCall } from '../../src/mock/fake-model.ts';
import { runServer, type RunningServer } from '../../src/server/main.ts';
import { ReportSchema } from '../../src/types/report.ts';
import { REPO_ROOT } from '../support/home.ts';
import { allowLoopback } from '../support/no-io-guard.ts';
import { brief, evalHome, findings, reportDraft, type EvalHome } from './eval-support.ts';

const TOKEN = 'contract-token';

/** A loopback port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Replaces KEY=... lines in the home's .env. */
function setEnv(home: string, values: Record<string, string>): void {
  const file = join(home, '.env');
  let body = readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^${key}=.*$`, 'm');
    body = line.test(body) ? body.replace(line, `${key}=${value}`) : `${body}\n${key}=${value}\n`;
  }
  writeFileSync(file, body);
}

let home: EvalHome;
let server: RunningServer;
let revoke: () => void;
let script: FauxScript;
let base: string;

beforeAll(async () => {
  const port = await freePort();
  home = evalHome();
  setEnv(home.home, { TRIAGE_HTTP_AUTH_TOKEN: TOKEN, TRIAGE_HTTP_PORT: String(port) });

  const fake = createFakeModel();
  fake.install();
  script = fauxScript({
    root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), finish(reportDraft('strong')), text('report written')],
    investigate_ssfb: [toolCall('note_evidence', findings('medium')), text('recorded')],
  });
  script.install(fake);

  server = await runServer();
  revoke = allowLoopback([server.port]);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  revoke?.();
  await server?.stop();
  resetRuntimeForTests();
  home?.dispose();
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('runServer', () => {
  test('listens on TRIAGE_HTTP_PORT and refuses a request without the token', async () => {
    const res = await fetch(`${base}/triage/01K5ZZZZZZZZZZZZZZZZZZZZZZ`);
    expect(res.status).toBe(401);
  });

  test('a triage posted over HTTP runs in the server runtime and completes with a valid report', async () => {
    const cases = await loadCases(join(REPO_ROOT, 'evals/cases'));
    const c = cases.find((x) => x.case.id === 'syn-strong-category')!.case;
    const messages = (c.request as { messages: unknown[] }).messages;

    const posted = await fetch(`${base}/triage`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ messages, requested_by: 'contract-test' }),
    });
    expect(posted.status).toBe(202);
    const { run_id } = (await posted.json()) as { run_id: string };

    // The run record is written by the background submission, so the first
    // polls can answer 404. Once it has answered 200 it must keep doing so.
    let view: { status: string; phase: string; classification: { tier_final?: string } | null; report?: unknown } | undefined;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/triage/${run_id}`, { headers: auth });
      if (res.status === 404 && view === undefined) {
        await res.body?.cancel();
      } else {
        expect(res.status).toBe(200);
        view = (await res.json()) as typeof view;
        if (view?.status !== 'running') break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(script.failures()).toEqual([]);
    expect(view?.phase).toBe('completed');
    expect(view?.classification?.tier_final).toBe('strong');
    expect(v.is(ReportSchema, { ...(view?.report as object), run_id })).toBe(true);
    expect(script.left()).toEqual({ root: 0, investigate_ssfb: 0 });
  });
});
