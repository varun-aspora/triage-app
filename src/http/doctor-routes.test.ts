import { describe, expect, test } from 'bun:test';
import { makeTestConfig } from '../../test/support/fake-tool-context.ts';
import { doctorReport, type DoctorReportOptions } from '../ops/doctor/report.ts';
import type { DoctorReport, NamedCheck } from '../ops/doctor/types.ts';
import { createDoctorRoutes, type DoctorRouteDeps } from './doctor-routes.ts';

const config = makeTestConfig();

const okRow: NamedCheck = { id: 'env', run: async () => [{ id: 'env', status: 'ok', key_names: [], message: 'env ok' }] };
const failRow: NamedCheck = { id: 'db', run: async () => [{ id: 'db', entity: 'ssfb', status: 'fail', key_names: ['SSFB_DB_URL'], message: 'db failed' }] };
const warnRow: NamedCheck = { id: 'quickwit', run: async () => [{ id: 'quickwit', status: 'warn', key_names: [], message: 'quickwit warned' }] };
const CHECKS = [okRow, failRow, warnRow];

// The real doctorReport with no real deps: the fake checks never read them.
const fakeReport: DoctorRouteDeps['report'] = (c, o) => doctorReport(c, { ...o, deps: () => ({ embedder: null }) });

function routes(over: Partial<DoctorRouteDeps> = {}) {
  return createDoctorRoutes({ config: () => config, checks: CHECKS, report: fakeReport, ...over });
}

type Body = { checks: { id: string; status: string }[]; counts: Record<string, number> };

describe('GET /doctor', () => {
  test('answers 200 with {checks, counts}, fail rows included', async () => {
    const res = await routes().request('/doctor');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(Object.keys(body).sort()).toEqual(['checks', 'counts']);
    expect(body.checks.map((c) => c.id).sort()).toEqual(['db', 'env', 'quickwit']);
    expect(body.counts).toMatchObject({ ok: 1, warn: 1, fail: 1 });
  });

  test('check= runs only the named checks, repeated or comma-separated', async () => {
    const seen: DoctorReportOptions[] = [];
    const report: DoctorRouteDeps['report'] = (c, o) => (seen.push(o), fakeReport(c, o));
    const app = routes({ report });
    const one = (await (await app.request('/doctor?check=db')).json()) as Body;
    expect(one.checks.map((c) => c.id)).toEqual(['db']);
    const two = (await (await app.request('/doctor?check=quickwit,env&check=env')).json()) as Body;
    expect(two.checks.map((c) => c.id).sort()).toEqual(['env', 'quickwit']);
    expect(seen.map((o) => o.only)).toEqual([['db'], ['env', 'quickwit']]);
  });

  test('an unknown or empty check is a 400 naming the valid ones', async () => {
    for (const q of ['check=nope', 'check=env,nope', 'check=', 'check=,']) {
      const res = await routes().request(`/doctor?${q}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request', fields: ['check'], valid_checks: ['env', 'db', 'quickwit'] });
    }
  });

  test('errors_only=true leaves out ok rows and keeps the full counts', async () => {
    const body = (await (await routes().request('/doctor?errors_only=true')).json()) as Body;
    expect(body.checks.map((c) => c.status).sort()).toEqual(['fail', 'warn']);
    expect(body.counts.ok).toBe(1);
  });

  test('sort_by is passed through; a bad sort_by or errors_only is a 400', async () => {
    const seen: DoctorReportOptions[] = [];
    const app = routes({ report: (c, o) => (seen.push(o), fakeReport(c, o)) });
    await app.request('/doctor');
    await app.request('/doctor?sort_by=check');
    expect(seen.map((o) => o.sortBy)).toEqual(['entity', 'check']);
    expect((await app.request('/doctor?sort_by=status')).status).toBe(400);
    expect((await app.request('/doctor?errors_only=yes')).status).toBe(400);
  });

  test('requests that arrive during a run share it; the next one starts a new run', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const report: DoctorRouteDeps['report'] = async (c, o) => {
      runs += 1;
      await gate;
      return fakeReport(c, o);
    };
    const app = routes({ report });
    const pending = [app.request('/doctor'), app.request('/doctor'), app.request('/doctor?errors_only=true')];
    // A different selection is a different run.
    const other = app.request('/doctor?check=env');
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toBe(2);
    release();
    for (const res of await Promise.all([...pending, other])) expect(res.status).toBe(200);
    await app.request('/doctor');
    expect(runs).toBe(3);
  });

  test('a report that throws answers 500 with the class name only in the log', async () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(' '));
    try {
      const res = await routes({ report: async () => { throw new Error('postgresql://u:p@h/db'); } }).request('/doctor');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal error' });
      expect(JSON.stringify(logged)).not.toContain('postgresql://');
    } finally {
      console.error = original;
    }
  });
});
