import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseSkillFile } from '../agents/skills.ts';
import { loadConfig } from '../config/env.ts';
import { loadRegistry } from '../config/registry.ts';
import { loadRepos } from '../config/repos.ts';
import { formatEntityDoc, formatPins } from '../ops/catalog/registry.ts';
import { safeJoin } from '../ops/catalog/validate.ts';
import { makeTestHome, RESOURCES_DIR, type TestHome } from '../../test/support/home.ts';
import { checkSkillTree, lintText } from '../../test/knowledge/_util.ts';
import { createCatalogRoutes } from './catalog-routes.ts';

// A value planted in the .env; no response may ever contain it.
const PLANTED = 'planted-value-q7z';

let home: TestHome;
let knowledge: string;
let resources: string;

function skill(rel: string, text: string): void {
  const path = join(knowledge, rel, 'SKILL.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fm(name: string, meta: string, description = `About ${name}. Use when it matters.`): string {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n${meta}---\n\n# ${name}\n\nSome text.\n`;
}

beforeEach(() => {
  home = makeTestHome({
    entities: ['ssfb', 'rtl'],
    overrides: {
      RTL_WORKFLOW_DB_URL: PLANTED,
      RTL_BILLING_DB_URL: '',
      RTL_BILLING_API_URL: PLANTED,
      RTL_LEDGER_DB_URL: '',
    },
  });
  knowledge = home.config.paths.knowledgeDir;
  resources = home.config.paths.resourcesDir;
  skill('rtl-workflow', fm('rtl-workflow', '  kind: service\n  entity: rtl\n  service: workflow\n  status: ported\n'));
  skill('rtl-overview', fm('rtl-overview', '  kind: overview\n  entity: rtl\n  status: written\n'));
  skill('ssfb-harbor', fm('ssfb-harbor', '  kind: service\n  entity: ssfb\n  service: harbor\n  status: stub\n'));
  writeFileSync(join(knowledge, 'ssfb-harbor', 'extra.json'), '{}\n');
  skill('group/patterns', fm('patterns', '  kind: patterns\n  entity: shared\n'));
  mkdirSync(join(knowledge, 'broken'), { recursive: true });
  writeFileSync(join(knowledge, 'broken', 'SKILL.md'), 'no front-matter here\n');
  mkdirSync(join(knowledge, 'method'), { recursive: true });
  writeFileSync(join(knowledge, 'method', 'orchestrator.md'), 'always on\n');
  mkdirSync(join(knowledge, 'classifier'), { recursive: true });
  writeFileSync(join(knowledge, 'classifier', 'categories.json'), '[]\n');
});

afterEach(() => home.cleanup());

// Response bodies are checked field by field, so they are read untyped.
const json = (res: Response): Promise<any> => res.json();

const routes = () => createCatalogRoutes({ config: () => home.config });

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** Every file under the home with its bytes, to prove a request wrote nothing. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        out.set(`${relative(home.home, path)}/`, '');
        walk(path);
      } else out.set(relative(home.home, path), readFileSync(path, 'utf8'));
    }
  };
  walk(home.home);
  return out;
}

const readEntity = (entity: string) => JSON.parse(readFileSync(join(resources, `${entity}.entity.json`), 'utf8'));
const readPinsJson = () => JSON.parse(readFileSync(join(resources, 'repos.json'), 'utf8')) as { repo: string; entities: string[] }[];

const BILLING = {
  entity: 'rtl',
  key: 'billing',
  repo: 'reminder-service',
  quickwit_service: 'billing-svc',
  db_env: 'RTL_BILLING_DB_URL',
  api_env: 'RTL_BILLING_API_URL',
  note: 'bills and invoices',
};

// ------------------------------------------------------------------ services

describe('GET /services', () => {
  test('lists enabled entities with env key names and states, never values', async () => {
    const res = await routes().request('/services');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PLANTED);
    const body = JSON.parse(text);
    expect(body.restart_required).toBe(false);
    expect(body.entities.map((e: { entity: string }) => e.entity)).toEqual(['ssfb', 'rtl']);

    const rtl = body.entities[1].services;
    expect(rtl.map((s: { key: string }) => s.key)).toEqual(['workflow', 'banking', 'kyc', 'canopy', 'cohort', 'comms']);
    expect(rtl[0]).toEqual({
      key: 'workflow',
      repo: 'workflow-op',
      quickwit_service: 'workflow-op',
      db_env: { name: 'RTL_WORKFLOW_DB_URL', state: 'set' },
      api_env: { name: 'RTL_WORKFLOW_API_URL', state: 'blank' },
      transport: null,
      note: expect.any(String),
      guide: { name: 'rtl-workflow', status: 'ported' },
      pending_restart: false,
    });
    expect(rtl[1].guide).toBeNull();

    const ssfb = body.entities[0].services;
    const finacle = ssfb.find((s: { key: string }) => s.key === 'finacle');
    expect(finacle).toMatchObject({ transport: 'cbs', repo: null, db_env: null, api_env: { name: 'SSFB_CBS_GATEWAY_URL' } });
    expect(ssfb.find((s: { key: string }) => s.key === 'harbor').guide).toEqual({ name: 'ssfb-harbor', status: 'stub' });

    expect(body.repos).toContainEqual({ repo: 'comms-svc', entities: ['ssfb', 'atspl', 'rtl'] });
  });

  test('a key missing from the .env reads as missing', async () => {
    const env = join(home.home, '.env');
    writeFileSync(env, readFileSync(env, 'utf8').replace(/^RTL_KYC_DB_URL=.*$/m, ''));
    const body = await json(await routes().request('/services'));
    const kyc = body.entities[1].services.find((s: { key: string }) => s.key === 'kyc');
    expect(kyc.db_env).toEqual({ name: 'RTL_KYC_DB_URL', state: 'missing' });
  });
});

describe('POST /services', () => {
  test('writes the entity file, the pin and a stub guide, and the next boot still loads', async () => {
    const entityBefore = statSync(join(resources, 'rtl.entity.json')).mode & 0o777;
    const app = routes();
    const res = await app.request('/services', post(BILLING));
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(PLANTED);
    const body = JSON.parse(text);
    expect(body).toEqual({
      entity: 'rtl',
      key: 'billing',
      files: [
        { path: 'knowledge/rtl-billing/SKILL.md', action: 'created' },
        { path: 'resources/rtl.entity.json', action: 'updated' },
        { path: 'resources/repos.json', action: 'updated' },
      ],
      warnings: ['RTL_BILLING_DB_URL is blank in the .env; the investigator skips this database until it is set'],
      restart_required: true,
    });

    const spec = readEntity('rtl').services.billing;
    expect(Object.keys(spec)).toEqual(['db', 'api', 'quickwit_service', 'repo', 'note']);
    expect(spec).toEqual({
      db: 'RTL_BILLING_DB_URL',
      api: 'RTL_BILLING_API_URL',
      quickwit_service: 'billing-svc',
      repo: 'reminder-service',
      note: 'bills and invoices',
    });
    expect(readPinsJson().find((p) => p.repo === 'reminder-service')?.entities).toEqual(['ssfb', 'rtl']);
    // Layout kept: one pin per line, entity file in its hand-written shape.
    const reposText = readFileSync(join(resources, 'repos.json'), 'utf8');
    expect(reposText).toContain('  { "repo": "reminder-service", "entities": ["ssfb", "rtl"] },\n');
    expect(statSync(join(resources, 'rtl.entity.json')).mode & 0o777).toBe(entityBefore);

    // What the next boot does with these files.
    const config = loadConfig({ home: home.home });
    const registry = loadRegistry(config);
    expect(registry.services('rtl')).toContain('billing');
    const pins = loadRepos(config, registry);
    expect(pins.find((p) => p.repo === 'reminder-service')?.entities).toEqual(['ssfb', 'rtl']);

    const guidePath = join(knowledge, 'rtl-billing', 'SKILL.md');
    expect(statSync(guidePath).mode & 0o777).toBe(0o644);
    const guide = readFileSync(guidePath, 'utf8');
    expect(lintText(guide)).toEqual([]);
    expect(checkSkillTree(knowledge).filter((p) => p.path.startsWith('rtl-billing/'))).toEqual([]);
    const parsed = parseSkillFile(guide);
    expect('error' in parsed).toBe(false);

    const services = await json(await app.request('/services'));
    expect(services.restart_required).toBe(true);
    const billing = services.entities[1].services.find((s: { key: string }) => s.key === 'billing');
    expect(billing).toMatchObject({
      pending_restart: true,
      guide: { name: 'rtl-billing', status: 'stub' },
      db_env: { name: 'RTL_BILLING_DB_URL', state: 'blank' },
      api_env: { name: 'RTL_BILLING_API_URL', state: 'set' },
    });
    expect(services.entities[1].services.find((s: { key: string }) => s.key === 'kyc').pending_restart).toBe(false);

    const guides = await json(await app.request('/guides'));
    expect(guides.restart_required).toBe(true);
    expect(guides.guides.find((g: { name: string }) => g.name === 'rtl-billing')).toMatchObject({ status: 'stub', pending_restart: true });
  });

  test('leaves repos.json alone when the pin already lists the entity, and skips the guide on request', async () => {
    const pinsBefore = readFileSync(join(resources, 'repos.json'), 'utf8');
    const res = await routes().request(
      '/services',
      post({ entity: 'rtl', key: 'ledger', repo: 'workflow-op', db_env: 'RTL_LEDGER_DB_URL', create_guide: false }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.files).toEqual([{ path: 'resources/rtl.entity.json', action: 'updated' }]);
    expect(readFileSync(join(resources, 'repos.json'), 'utf8')).toBe(pinsBefore);
    expect(existsSync(join(knowledge, 'rtl-ledger'))).toBe(false);
    expect(readEntity('rtl').services.ledger).toEqual({ db: 'RTL_LEDGER_DB_URL', repo: 'workflow-op' });
  });

  test('blank optional fields count as left out', async () => {
    const res = await routes().request(
      '/services',
      post({ entity: 'ssfb', key: 'ledger', repo: 'harbor', quickwit_service: '', db_env: '', api_env: ' ', note: '', create_guide: false }),
    );
    expect(res.status).toBe(201);
    expect(readEntity('ssfb').services.ledger).toEqual({ repo: 'harbor' });
  });

  const rejects: [string, Record<string, unknown>, string][] = [
    ['underscore key', { key: 'bill_ing' }, 'key'],
    ['hyphen key', { key: 'bill-ing' }, 'key'],
    ['uppercase key', { key: 'Billing' }, 'key'],
    ['reserved key', { key: 'overview' }, 'key'],
    ['long key', { key: `a${'b'.repeat(40)}` }, 'key'],
    ['traversal key', { key: '../../etc' }, 'key'],
    ['unknown repo', { repo: 'not-a-repo' }, 'repo'],
    ['traversal repo', { repo: '../resources' }, 'repo'],
    ['disabled entity', { entity: 'atspl' }, 'entity'],
    ['alias entity', { entity: 'shivalik' }, 'entity'],
    ['wrong env prefix', { db_env: 'SSFB_BILLING_DB_URL' }, 'db_env'],
    ['env missing from .env', { db_env: 'RTL_NOWHERE_DB_URL' }, 'db_env'],
    ['config key as env', { api_env: 'TRIAGE_HTTP_AUTH_TOKEN' }, 'api_env'],
    ['multi-line note', { note: 'one\ntwo' }, 'note'],
    ['long note', { note: 'x'.repeat(501) }, 'note'],
    ['bad quickwit service', { quickwit_service: 'a b' }, 'quickwit_service'],
    ['email in note', { note: 'ask someone@example.com' }, 'note'],
    ['phone in guide description', { guide_description: 'call 9876543210 for help' }, 'guide_description'],
    ['multi-line guide description', { guide_description: 'a\u2028b' }, 'guide_description'],
    ['bad create_guide', { create_guide: 'yes' }, 'create_guide'],
    ['unknown field', { branch: 'main' }, 'branch'],
  ];

  for (const [label, change, field] of rejects) {
    test(`400 for ${label}, and nothing is written`, async () => {
      const before = snapshot();
      const submitted = { ...BILLING, ...change };
      const res = await routes().request('/services', post(submitted));
      expect(res.status).toBe(400);
      const text = await res.text();
      const body = JSON.parse(text);
      expect(body.error).toBe('invalid request');
      expect(body.fields).toContain(field);
      // Error bodies name fields; they never repeat what was sent.
      for (const value of Object.values(change)) {
        if (typeof value === 'string' && value.length > 3 && value !== 'atspl' && value !== 'overview') expect(text).not.toContain(value);
      }
      expect(snapshot()).toEqual(before);
    });
  }

  test('the missing-key reason explains the boot trap', async () => {
    const res = await routes().request('/services', post({ ...BILLING, db_env: 'RTL_NOWHERE_DB_URL' }));
    expect((await json(res)).reason).toContain('will not boot');
  });

  test('400 for a body that is not JSON or not an object', async () => {
    expect((await routes().request('/services', post('{nope'))).status).toBe(400);
    expect((await routes().request('/services', post('[]'))).status).toBe(400);
  });

  test('409 for an existing key, and nothing is written', async () => {
    const before = snapshot();
    const res = await routes().request('/services', post({ ...BILLING, key: 'workflow' }));
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'service exists', fields: ['key'] });
    expect(snapshot()).toEqual(before);
  });

  test('409 when a directory with the guide name exists anywhere in the tree', async () => {
    mkdirSync(join(knowledge, 'group', 'rtl-billing'), { recursive: true });
    const before = snapshot();
    const res = await routes().request('/services', post(BILLING));
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'guide exists', fields: ['key'] });
    expect(snapshot()).toEqual(before);
    // Without a guide the service can still be added.
    expect((await routes().request('/services', post({ ...BILLING, create_guide: false }))).status).toBe(201);
  });

  test('two requests for the same key: one wins, the other gets 409', async () => {
    const app = routes();
    const [a, b] = await Promise.all([app.request('/services', post(BILLING)), app.request('/services', post(BILLING))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  test.skipIf(process.getuid?.() === 0)('removes the new guide when the registry write fails', async () => {
    const before = readFileSync(join(resources, 'rtl.entity.json'), 'utf8');
    chmodSync(resources, 0o555);
    const logged = console.error;
    console.error = () => {};
    try {
      const res = await routes().request('/services', post(BILLING));
      expect(res.status).toBe(500);
      expect(await json(res)).toEqual({ error: 'internal error' });
    } finally {
      console.error = logged;
      chmodSync(resources, 0o755);
    }
    expect(existsSync(join(knowledge, 'rtl-billing'))).toBe(false);
    expect(readFileSync(join(resources, 'rtl.entity.json'), 'utf8')).toBe(before);
  });
});

// -------------------------------------------------------------------- guides

describe('GET /guides', () => {
  test('lists every skill found the way the loader finds them, with counts', async () => {
    const res = await routes().request('/guides');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.restart_required).toBe(false);
    expect(body.guides.map((g: { name: string }) => g.name)).toEqual(['broken', 'patterns', 'rtl-overview', 'rtl-workflow', 'ssfb-harbor']);
    expect(body.counts).toEqual({ total: 5, ported: 1, written: 1, stub: 1 });
    expect(body.guides.find((g: { name: string }) => g.name === 'rtl-workflow')).toEqual({
      name: 'rtl-workflow',
      kind: 'service',
      entity: 'rtl',
      service: 'workflow',
      status: 'ported',
      description: 'About rtl-workflow. Use when it matters.',
      sources: null,
      pending_restart: false,
    });
    expect(body.guides.find((g: { name: string }) => g.name === 'patterns')).toMatchObject({ kind: 'patterns', entity: 'shared', service: null });
    const broken = body.guides.find((g: { name: string }) => g.name === 'broken');
    expect(broken.description).toBe('');
    expect(typeof broken.problem).toBe('string');
  });

  test('flags a name that does not match its directory', async () => {
    skill('rtl-kyc', fm('rtl-cohort', '  kind: service\n  entity: rtl\n  service: cohort\n  status: stub\n'));
    const body = await json(await routes().request('/guides'));
    expect(body.guides.find((g: { name: string }) => g.name === 'rtl-kyc').problem).toContain('does not match');
  });

  test('a missing knowledge dir is an empty list', async () => {
    const other = makeTestHome({ entities: ['rtl'], overrides: { TRIAGE_KNOWLEDGE_DIR: './no-such-dir' } });
    try {
      const body = await json(await createCatalogRoutes({ config: () => other.config }).request('/guides'));
      expect(body.counts.total).toBe(0);
    } finally {
      other.cleanup();
    }
  });
});

describe('GET /guides/:name', () => {
  test('returns the body and supporting files', async () => {
    const res = await routes().request('/guides/ssfb-harbor');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ name: 'ssfb-harbor', status: 'stub', files: ['extra.json'] });
    expect(body.body).toBe('# ssfb-harbor\n\nSome text.');
    expect(body.dir).toBeUndefined();
  });

  test('finds a nested skill', async () => {
    expect((await routes().request('/guides/patterns')).status).toBe(200);
  });

  test('400 for a bad name, 404 for an unknown one', async () => {
    for (const name of ['Bad_Name', 'a--b', `a${'b'.repeat(64)}`, '..%2f..%2fresources', '%2e%2e']) {
      const res = await routes().request(`/guides/${name}`);
      expect([400, 404]).toContain(res.status);
      if (res.status === 400) expect((await json(res)).fields).toEqual(['name']);
    }
    expect((await routes().request('/guides/Bad_Name')).status).toBe(400);
    const missing = await routes().request('/guides/rtl-nothing');
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ error: 'guide not found' });
  });
});

describe('POST /guides', () => {
  const KYC = {
    kind: 'service',
    entity: 'rtl',
    service: 'kyc',
    description: 'KYC checks and their tables. Use when a user is stuck at KYC.',
    sources: 'rtl/kyc/AGENTS.md, notes: from the design doc #3',
    status: 'written',
    body: '# kyc\n\nThe kyc service checks documents. Look up <customer_id> with `sql_select`.\n',
  };

  test('writes a SKILL.md that the loader and the knowledge checks accept', async () => {
    const app = routes();
    const res = await app.request('/guides', post(KYC));
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ name: 'rtl-kyc', file: 'knowledge/rtl-kyc/SKILL.md', restart_required: true });

    const text = readFileSync(join(knowledge, 'rtl-kyc', 'SKILL.md'), 'utf8');
    expect(checkSkillTree(knowledge).filter((p) => p.path.startsWith('rtl-kyc/'))).toEqual([]);
    expect(lintText(text)).toEqual([]);
    const parsed = parseSkillFile(text);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.fields['description']).toBe(KYC.description);
    expect(parsed.fields['metadata']).toEqual({ kind: 'service', entity: 'rtl', service: 'kyc', sources: KYC.sources, status: 'written' });
    expect(parsed.body).toBe(KYC.body.trim());

    const detail = await json(await app.request('/guides/rtl-kyc'));
    expect(detail).toMatchObject({ name: 'rtl-kyc', status: 'written', sources: KYC.sources, pending_restart: true });
    expect((await json(await app.request('/guides'))).restart_required).toBe(true);
  });

  test('names an overview <entity>-overview and refuses one that exists', async () => {
    const overview = { kind: 'overview', entity: 'ssfb', description: 'The SSFB id chain. Use first.', status: 'stub', body: 'Text.' };
    const res = await routes().request('/guides', post(overview));
    expect(res.status).toBe(201);
    expect((await json(res)).name).toBe('ssfb-overview');
    expect(checkSkillTree(knowledge).filter((p) => p.path.startsWith('ssfb-overview/'))).toEqual([]);

    const again = await routes().request('/guides', post({ ...overview, entity: 'rtl' }));
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ error: 'guide exists', fields: ['name'] });
  });

  test('the service must be in the registry file on disk, so a just-added one qualifies', async () => {
    const app = routes();
    const guide = { ...KYC, service: 'billing' };
    const early = await app.request('/guides', post(guide));
    expect(early.status).toBe(400);
    expect((await json(early)).fields).toEqual(['service']);

    expect((await app.request('/services', post({ ...BILLING, create_guide: false }))).status).toBe(201);
    expect((await app.request('/guides', post(guide))).status).toBe(201);
  });

  const rejects: [string, Record<string, unknown>, string][] = [
    ['global kind', { kind: 'patterns' }, 'kind'],
    ['unknown entity', { entity: 'nope' }, 'entity'],
    ['missing service', { service: undefined }, 'service'],
    ['traversal service', { service: '../../etc' }, 'service'],
    ['hyphen service', { service: 'kyc-x' }, 'service'],
    ['overview with a service', { kind: 'overview', service: 'kyc' }, 'service'],
    ['empty description', { description: '  ' }, 'description'],
    ['multi-line description', { description: 'a\nb' }, 'description'],
    ['long description', { description: 'x'.repeat(1025) }, 'description'],
    ['multi-line sources', { sources: 'a\nb' }, 'sources'],
    ['bad status', { status: 'draft' }, 'status'],
    ['empty body', { body: ' \n ' }, 'body'],
    ['long body', { body: 'x'.repeat(100_001) }, 'body'],
    ['email in body', { body: 'Write to someone@example.com' }, 'body'],
    ['long digit run in description', { description: 'Account 12345678 is stuck' }, 'description'],
    ['unknown field', { name: 'rtl-kyc' }, 'name'],
  ];

  for (const [label, change, field] of rejects) {
    test(`400 for ${label}, and nothing is written`, async () => {
      const before = snapshot();
      const res = await routes().request('/guides', post({ ...KYC, ...change }));
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.fields).toContain(field);
      expect(snapshot()).toEqual(before);
    });
  }

  test('a body line that looks like front-matter still reads back as written', async () => {
    const res = await routes().request('/guides', post({ ...KYC, body: 'Intro.\n\n---\n\nname: other\n' }));
    expect(res.status).toBe(201);
    const parsed = parseSkillFile(readFileSync(join(knowledge, 'rtl-kyc', 'SKILL.md'), 'utf8'));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.fields['name']).toBe('rtl-kyc');
  });
});

// ------------------------------------------------------------------ helpers

describe('file layout', () => {
  test('the entity and repos formatters reproduce the repo files byte for byte', () => {
    for (const entity of ['ssfb', 'atspl', 'rtl']) {
      const text = readFileSync(join(RESOURCES_DIR, `${entity}.entity.json`), 'utf8');
      expect(formatEntityDoc(JSON.parse(text))).toBe(text);
    }
    const repos = readFileSync(join(RESOURCES_DIR, 'repos.json'), 'utf8');
    expect(formatPins(JSON.parse(repos))).toBe(repos);
  });

  test('safeJoin keeps paths under the root', () => {
    expect(safeJoin('/k', 'rtl-kyc', 'SKILL.md')).toBe('/k/rtl-kyc/SKILL.md');
    expect(safeJoin('/k', '..', 'etc')).toBeUndefined();
    expect(safeJoin('/k', '/etc')).toBeUndefined();
    expect(safeJoin('/k', 'a\\..\\b')).toBeUndefined();
    expect(safeJoin('/k', 'a\0b')).toBeUndefined();
    expect(safeJoin('/k', '')).toBeUndefined();
    expect(safeJoin('/k', '.')).toBeUndefined();
  });
});
