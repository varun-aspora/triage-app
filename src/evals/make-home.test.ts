import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { loadConfig } from '../config/env.ts';
import { ENTITY_KEY_PATTERN } from '../config/keys.ts';
import { envNamesOf, loadRegistry, registryFile, EntityRegistrySchema } from '../config/registry.ts';
import { ENTITIES } from '../types/core.ts';
import * as v from 'valibot';
import { EvalHomeError, assertEvalHome, credentialKeys } from './home.ts';
import { EVAL_HOME_MARKER, EVAL_HOME_TEMPLATE, REPO_PLACEHOLDER, materialiseEvalHome, renderEvalEnv } from './make-home.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const TEMPLATE_TEXT = readFileSync(join(ROOT, EVAL_HOME_TEMPLATE), 'utf8');
const TEMPLATE: Readonly<Record<string, string>> = parse(TEMPLATE_TEXT);
// The root template, not a real .env.
const ROOT_EXAMPLE: Readonly<Record<string, string>> = parse(readFileSync(join(ROOT, '.env.example'), 'utf8'));

// Non-credential entity keys the template may keep a value for.
const ENTITY_KEYS_WITH_VALUES = new Set([
  'SSFB_QUICKWIT_TRANSPORT',
  'SSFB_QUICKWIT_INDEX',
  'SSFB_QUICKWIT_AUTH',
  'SSFB_QUICKWIT_MAX_CONCURRENCY',
  'SSFB_QUICKWIT_MAX_HITS',
  'SSFB_CBS_VIA_KUBECTL_ENABLED',
  'ATSPL_QUICKWIT_TRANSPORT',
  'ATSPL_QUICKWIT_INDEX',
  'ATSPL_QUICKWIT_AUTH',
  'ATSPL_QUICKWIT_MAX_CONCURRENCY',
  'ATSPL_QUICKWIT_MAX_HITS',
  'RTL_QUICKWIT_TRANSPORT',
  'RTL_QUICKWIT_AUTH',
  'RTL_QUICKWIT_MAX_CONCURRENCY',
  'RTL_QUICKWIT_MAX_HITS',
]);

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'triage-eval-home-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function registryDocs() {
  return ENTITIES.map((e) => v.parse(EntityRegistrySchema, JSON.parse(readFileSync(join(ROOT, 'resources', registryFile(e)), 'utf8'))));
}

describe('evals/home/.env.example', () => {
  test('has the same key set as the root .env.example', () => {
    expect(Object.keys(TEMPLATE).sort()).toEqual(Object.keys(ROOT_EXAMPLE).sort());
  });

  test('has every key referenced by resources/*.entity.json', () => {
    for (const spec of registryDocs()) {
      for (const name of envNamesOf(spec)) expect(Object.keys(TEMPLATE)).toContain(name);
    }
  });

  test('entity keys are blank apart from non-credential Quickwit settings and the CBS flag', () => {
    const set = Object.entries(TEMPLATE).filter(([k, value]) => ENTITY_KEY_PATTERN.test(k) && value !== '');
    for (const [k] of set) expect({ key: k, allowed: ENTITY_KEYS_WITH_VALUES.has(k) }).toEqual({ key: k, allowed: true });
    expect(TEMPLATE.SSFB_CBS_VIA_KUBECTL_ENABLED).toBe('false');
  });

  test('credential, provider, Slack and HTTP secrets are blank', () => {
    const blank = [
      'SLACK_BOT_TOKEN',
      'SLACK_SIGNING_SECRET',
      'SLACK_REVIEWER_EMAIL',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'OLLAMA_BASE_URL',
      'E2B_API_KEY',
      'DAYTONA_API_KEY',
      'DAYTONA_API_URL',
      'TRIAGE_HTTP_AUTH_TOKEN',
      'TRIAGE_HOME',
    ];
    for (const k of blank) expect({ key: k, value: TEMPLATE[k] }).toEqual({ key: k, value: '' });
  });

  test('no value looks like a DSN, address or remote host', () => {
    const hosty = [/@/, /:\/\//, /\blocalhost\b/i, /\b\d{1,3}(\.\d{1,3}){3}\b/, /\.(com|in|xyz|finance|local|internal)\b/];
    for (const [k, value] of Object.entries(TEMPLATE)) {
      expect({ key: k, hosty: hosty.some((re) => re.test(value)) }).toEqual({ key: k, hosty: false });
    }
  });

  test('forces mock strict, recording off, sqlite, virtual sandbox, faux models and no judge', () => {
    expect(TEMPLATE).toMatchObject({
      TRIAGE_MOCK_MODE: 'true',
      TRIAGE_MOCK_STRICT: 'true',
      TRIAGE_RECORD_FIXTURES: 'false',
      TRIAGE_DB_PROVIDER: 'sqlite',
      TRIAGE_SANDBOX_PROVIDER: 'virtual',
      MODEL_TIER_CHEAP: 'faux/cheap',
      MODEL_TIER_MID: 'faux/mid',
      MODEL_TIER_STRONG: 'faux/strong',
      MODEL_CLASSIFIER: 'faux/classifier',
      MODEL_EMBEDDING: '',
      TRIAGE_EVAL_JUDGE_MODEL: '',
      TRIAGE_ENTITIES: 'ssfb,atspl,rtl',
    });
  });

  test('uses the __REPO__ placeholder for the knowledge and fixtures paths', () => {
    expect(TEMPLATE.TRIAGE_KNOWLEDGE_DIR).toBe(`${REPO_PLACEHOLDER}/knowledge`);
    expect(TEMPLATE.TRIAGE_FIXTURES_DIR).toBe(`${REPO_PLACEHOLDER}/fixtures`);
    expect(TEMPLATE_TEXT).toContain(`${REPO_PLACEHOLDER}/resources`);
  });
});

describe('renderEvalEnv', () => {
  test('replaces every __REPO__ with the repo root', () => {
    const text = renderEvalEnv(ROOT);
    expect(text).not.toContain(REPO_PLACEHOLDER);
    const env = parse(text);
    expect(env.TRIAGE_KNOWLEDGE_DIR).toBe(join(ROOT, 'knowledge'));
    expect(env.TRIAGE_FIXTURES_DIR).toBe(join(ROOT, 'fixtures'));
  });

  test('keeps a repo root with spaces and # intact', () => {
    const root = join(tempDir(), 'my repo #1');
    mkdirSync(join(root, 'evals', 'home'), { recursive: true });
    cpSync(join(ROOT, EVAL_HOME_TEMPLATE), join(root, EVAL_HOME_TEMPLATE));
    expect(parse(renderEvalEnv(root)).TRIAGE_KNOWLEDGE_DIR).toBe(join(root, 'knowledge'));
  });

  test('refuses a relative root or one with a quote or newline', () => {
    expect(() => renderEvalEnv('relative/root')).toThrow('absolute');
    expect(() => renderEvalEnv("/tmp/it's")).toThrow('quotes or newlines');
    expect(() => renderEvalEnv('/tmp/a\nB=1')).toThrow('quotes or newlines');
  });
});

describe('materialiseEvalHome', () => {
  test('writes only under the target dir and leaves the repo untouched', () => {
    const base = tempDir();
    const fakeRepo = join(base, 'repo');
    mkdirSync(join(fakeRepo, 'evals', 'home'), { recursive: true });
    cpSync(join(ROOT, EVAL_HOME_TEMPLATE), join(fakeRepo, EVAL_HOME_TEMPLATE));
    cpSync(join(ROOT, 'resources'), join(fakeRepo, 'resources'), { recursive: true });
    const repoBefore = listFiles(fakeRepo);
    const baseBefore = readdirSync(base).sort();

    const target = join(base, 'eval-home');
    const home = materialiseEvalHome(target, fakeRepo);

    expect(home).toBe(target);
    expect(listFiles(fakeRepo)).toEqual(repoBefore);
    expect(readdirSync(base).sort()).toEqual([...baseBefore, 'eval-home'].sort());
    const resources = readdirSync(join(ROOT, 'resources')).map((f) => join('resources', f));
    expect(listFiles(home)).toEqual(['.env', EVAL_HOME_MARKER, ...resources].sort());
    expect(statSync(join(home, '.env')).mode & 0o777).toBe(0o600);
    const env = parse(readFileSync(join(home, '.env'), 'utf8'));
    expect(env.TRIAGE_KNOWLEDGE_DIR).toBe(join(fakeRepo, 'knowledge'));
    expect(env.TRIAGE_FIXTURES_DIR).toBe(join(fakeRepo, 'fixtures'));
  });

  test('loads through the config loader and registry with every capability disabled', () => {
    const home = materialiseEvalHome(join(tempDir(), 'home'), ROOT);
    const config = loadConfig({ home });
    const registry = loadRegistry(config);
    expect(config.home).toBe(home);
    expect(config.mock).toEqual({ enabled: true, strict: true, record: false });
    expect(config.paths.knowledgeDir).toBe(join(ROOT, 'knowledge'));
    expect(config.paths.fixturesDir).toBe(join(ROOT, 'fixtures'));
    expect(config.paths.dataDir).toBe(join(home, '.data'));
    expect(registry.enabledEntities()).toEqual([...ENTITIES]);
    for (const entity of ENTITIES) {
      const report = registry.capabilityReport(entity);
      expect(report.rows.length).toBeGreaterThan(0);
      for (const row of report.rows) {
        const label = { entity, capability: row.capability, service: row.service };
        expect({ ...label, off: row.status === 'blank' || row.status === 'disabled' }).toEqual({ ...label, off: true });
      }
      expect(registry.cbsEnabled(entity)).toBe(false);
      expect(registry.quickwit(entity).status).toBe('disabled');
    }
    expect(() => assertEvalHome(config, registry)).not.toThrow();
    for (const k of credentialKeys(registry)) expect(parse(readFileSync(join(home, '.env'), 'utf8'))[k]).toBe('');
  });

  test('refuses to overwrite a .env it did not write, and leaves it as it was', () => {
    const target = join(tempDir(), 'someone-elses-home');
    mkdirSync(target);
    writeFileSync(join(target, '.env'), 'TRIAGE_ENTITIES=ssfb\n');
    expect(() => materialiseEvalHome(target, ROOT)).toThrow(EvalHomeError);
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('TRIAGE_ENTITIES=ssfb\n');
    expect(readdirSync(target)).toEqual(['.env']);
  });

  test('rewrites a home it made itself', () => {
    const target = join(tempDir(), 'home');
    materialiseEvalHome(target, ROOT);
    writeFileSync(join(target, '.env'), 'stale\n');
    writeFileSync(join(target, 'resources', 'stale.json'), '{}');
    materialiseEvalHome(target, ROOT);
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe(renderEvalEnv(ROOT));
    expect(readdirSync(join(target, 'resources'))).not.toContain('stale.json');
  });

  test('refuses a relative target and the repo root itself', () => {
    expect(() => materialiseEvalHome('relative/home', ROOT)).toThrow('absolute');
    expect(() => materialiseEvalHome(ROOT, ROOT)).toThrow('repo root');
  });
});
