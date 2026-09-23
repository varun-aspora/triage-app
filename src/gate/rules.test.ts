import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { ENTITIES } from '../types/core.ts';
import { loadRulesFile, rulesFileName } from './rules-file.ts';
import { evaluateRule, HTTP_METHODS, matchTemplate, validateRules, type ApiRule } from './rules.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVICES = ['harbor', 'bro', 'rhythm', 'finacle', 'cohort'];

function rules(raw: unknown[]): readonly ApiRule[] {
  const result = validateRules(raw, SERVICES);
  expect(result.errors).toEqual([]);
  return result.rules;
}

function errorsOf(raw: unknown): readonly string[] {
  return validateRules(raw, SERVICES).errors;
}

// ------------------------------------------------------------ matchTemplate

describe('matchTemplate', () => {
  test("'*' alone matches every path", () => {
    expect(matchTemplate('*', '/')).toBe(true);
    expect(matchTemplate('*', '/a/b/c')).toBe(true);
  });

  test('exact template matches the whole path segment by segment', () => {
    expect(matchTemplate('/api/v1/users', '/api/v1/users')).toBe(true);
    expect(matchTemplate('/api/v1/users', '/api/v1/users/1')).toBe(false);
    expect(matchTemplate('/api/v1/users', '/api/v1')).toBe(false);
    expect(matchTemplate('/api/v1/users', '/api/v1/usersx')).toBe(false);
    expect(matchTemplate('/api/v1/users', '/API/v1/users')).toBe(false);
  });

  test("deny: '/custom/api/*' matches only at a segment boundary", () => {
    expect(matchTemplate('/custom/api/*', '/custom/api/x/y')).toBe(true);
    expect(matchTemplate('/custom/api/*', '/custom/api/x')).toBe(true);
    expect(matchTemplate('/custom/api/*', '/custom/apix')).toBe(false);
    expect(matchTemplate('/custom/api/*', '/custom/api')).toBe(false);
    expect(matchTemplate('/custom/api/*', '/other/custom/api/x')).toBe(false);
  });

  test("deny: ':form_id' needs exactly one non-empty segment", () => {
    const t = '/forms/:form_id/x';
    expect(matchTemplate(t, '/forms/abc-123/x')).toBe(true);
    expect(matchTemplate(t, '/forms//x')).toBe(false);
    expect(matchTemplate(t, '/forms/a/b/x')).toBe(false);
    expect(matchTemplate('/forms/:form_id', '/forms/')).toBe(false);
    expect(matchTemplate('/forms/:form_id', '/forms/a/b')).toBe(false);
  });

  test('query strings and fragments never match', () => {
    expect(matchTemplate('*', '/a?b=1')).toBe(false);
    expect(matchTemplate('/a', '/a?')).toBe(false);
    expect(matchTemplate('/a', '/a#x')).toBe(false);
    expect(matchTemplate('/a', 'a')).toBe(false);
  });

  test('a malformed template never matches', () => {
    expect(matchTemplate('api/v1', '/api/v1')).toBe(false);
    expect(matchTemplate('/a/*/b', '/a/x/b')).toBe(false);
    expect(matchTemplate('', '/')).toBe(false);
  });
});

// -------------------------------------------------------------- evaluateRule

describe('evaluateRule', () => {
  test('with [] rules GET and HEAD are allowed by default', () => {
    for (const method of ['GET', 'HEAD']) {
      const d = evaluateRule([], { service: 'harbor', method, pathname: '/api/v1/forms/1' });
      expect(d.action).toBe('allow');
      expect(d.rule_index).toBe('default');
    }
  });

  test('deny: POST, PUT, PATCH, DELETE, OPTIONS and TRACE with no rules are blocked by default', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
      const d = evaluateRule([], { service: 'harbor', method, pathname: '/admin/v1/customers/c1/trigger-delivery' });
      expect(d).toMatchObject({ action: 'block', rule_index: 'default' });
    }
  });

  test('deny: a lowercase or unknown request method is blocked by default', () => {
    for (const method of ['get', 'head', 'CONNECT', '', 'G E T']) {
      expect(evaluateRule([], { service: 'harbor', method, pathname: '/x' })).toMatchObject({ action: 'block', rule_index: 'default' });
    }
  });

  test("deny: a pathname containing '?' is refused, even for GET", () => {
    const r = rules([{ service: 'harbor', method: 'GET', api: '*', action: 'allow', confirm_broad: true, reason: 'test' }]);
    for (const pathname of ['/api/v1/forms?id=1', '/api?', '/a#b', 'api/v1', '']) {
      const d = evaluateRule(r, { service: 'harbor', method: 'GET', pathname });
      expect(d.action).toBe('block');
      expect(d.rule_index).toBe('default');
      expect(d.reason).toContain('query');
    }
  });

  test('first matching rule wins and its index and reason are returned', () => {
    const r = rules([
      { service: 'bro', method: 'POST', api: '/dashboard/api/v1/dry-run', action: 'allow', reason: 'no persist' },
      { service: 'bro', method: '*', api: '/admin/api/v1/stp-engine/rules/*', action: 'block' },
    ]);
    expect(evaluateRule(r, { service: 'bro', method: 'POST', pathname: '/dashboard/api/v1/dry-run' })).toEqual({
      action: 'allow',
      rule_index: 0,
      reason: 'no persist',
    });
    expect(evaluateRule(r, { service: 'bro', method: 'GET', pathname: '/admin/api/v1/stp-engine/rules/c1' })).toEqual({
      action: 'block',
      rule_index: 1,
    });
    expect(evaluateRule(r, { service: 'bro', method: 'PUT', pathname: '/admin/api/v1/stp-engine/rules/c1' }).rule_index).toBe(1);
  });

  test('deny: method match is exact', () => {
    const r = rules([{ service: 'harbor', method: 'POST', api: '/x', action: 'allow', reason: 'r' }]);
    expect(evaluateRule(r, { service: 'harbor', method: 'post', pathname: '/x' })).toMatchObject({ action: 'block', rule_index: 'default' });
    expect(evaluateRule(r, { service: 'harbor', method: 'PUT', pathname: '/x' })).toMatchObject({ action: 'block', rule_index: 'default' });
    expect(evaluateRule(r, { service: 'harbor', method: 'POST', pathname: '/x' })).toMatchObject({ action: 'allow', rule_index: 0 });
  });

  test('deny: a rule for one service does not allow the same path on another', () => {
    const r = rules([{ service: 'finacle', method: 'POST', api: '/custom/api/*', action: 'allow', reason: 'reads' }]);
    expect(evaluateRule(r, { service: 'finacle', method: 'POST', pathname: '/custom/api/x/y' }).action).toBe('allow');
    expect(evaluateRule(r, { service: 'harbor', method: 'POST', pathname: '/custom/api/x/y' })).toMatchObject({
      action: 'block',
      rule_index: 'default',
    });
    expect(evaluateRule(r, { service: 'finacle', method: 'POST', pathname: '/custom/apix' })).toMatchObject({
      action: 'block',
      rule_index: 'default',
    });
  });

  test('deny: {harbor, *, *, block} blocks harbor GETs; other services are unaffected', () => {
    const r = rules([{ service: 'harbor', method: '*', api: '*', action: 'block' }]);
    for (const method of ['GET', 'HEAD', 'POST']) {
      expect(evaluateRule(r, { service: 'harbor', method, pathname: '/api/v1/forms/1' })).toMatchObject({ action: 'block', rule_index: 0 });
    }
    expect(evaluateRule(r, { service: 'rhythm', method: 'GET', pathname: '/api/v1/forms/1' })).toMatchObject({
      action: 'allow',
      rule_index: 'default',
    });
    expect(evaluateRule(r, { service: 'rhythm', method: 'POST', pathname: '/api/v1/forms/1' })).toMatchObject({
      action: 'block',
      rule_index: 'default',
    });
  });

  // HLD §4.4 item 6.
  test('HLD example: GET block then * allow on the same path blocks GET and allows POST', () => {
    const r = rules([
      { service: 'harbor', method: 'GET', api: '/api/v1/transaction/:id', action: 'block' },
      { service: 'harbor', method: '*', api: '/api/v1/transaction/:id', action: 'allow', reason: 'example' },
      { service: 'harbor', method: '*', api: '*', action: 'block' },
      { service: 'rhythm', method: 'POST', api: '/api/v1/td-calculate', action: 'allow', reason: 'example' },
    ]);
    const on = (service: string, method: string, pathname: string) => evaluateRule(r, { service, method, pathname });

    expect(on('harbor', 'GET', '/api/v1/transaction/t1')).toMatchObject({ action: 'block', rule_index: 0 });
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      expect(on('harbor', method, '/api/v1/transaction/t1')).toMatchObject({ action: 'allow', rule_index: 1 });
    }
    // The later catch-all blocks everything else for harbor, GETs included.
    expect(on('harbor', 'GET', '/api/v1/forms/f1')).toMatchObject({ action: 'block', rule_index: 2 });
    expect(on('harbor', 'GET', '/api/v1/transaction/t1/items')).toMatchObject({ action: 'block', rule_index: 2 });
    // The rhythm POST is allowed and every rhythm GET falls to the default.
    expect(on('rhythm', 'POST', '/api/v1/td-calculate')).toMatchObject({ action: 'allow', rule_index: 3 });
    expect(on('rhythm', 'GET', '/api/v1/deposits/d1')).toMatchObject({ action: 'allow', rule_index: 'default' });
    expect(on('rhythm', 'POST', '/api/v1/deposits/config')).toMatchObject({ action: 'block', rule_index: 'default' });
  });

  test('HLD §4.4 sample file loads and behaves as documented', () => {
    const r = rules([
      { service: 'harbor', method: 'GET', api: '/admin/v1/forms/:form_id/trigger-customer-creation', action: 'block', reason: 'mutating' },
      { service: 'harbor', method: '*', api: '/admin/v1/customers/:customer_id/sync-address', action: 'block' },
      { service: 'bro', method: 'POST', api: '/admin/api/v1/stp-engine/clients/harbor_client/hooks/reference-query', action: 'allow', reason: 'exact' },
      { service: 'bro', method: '*', api: '/admin/api/v1/stp-engine/rules/*', action: 'block', reason: 'subtree' },
      { service: 'finacle', method: 'POST', api: '/custom/api/*', action: 'allow', reason: 'custom-script reads' },
    ]);
    const on = (service: string, method: string, pathname: string) => evaluateRule(r, { service, method, pathname });
    expect(on('harbor', 'GET', '/admin/v1/forms/f1/trigger-customer-creation')).toMatchObject({ action: 'block', rule_index: 0 });
    expect(on('harbor', 'GET', '/admin/v1/customers/c1/sync-address')).toMatchObject({ action: 'block', rule_index: 1 });
    expect(on('bro', 'POST', '/admin/api/v1/stp-engine/clients/harbor_client/hooks/reference-query').action).toBe('allow');
    expect(on('bro', 'POST', '/admin/api/v1/stp-engine/clients/other_client/hooks/reference-query')).toMatchObject({
      action: 'block',
      rule_index: 'default',
    });
    expect(on('bro', 'PUT', '/admin/api/v1/stp-engine/rules/check-1')).toMatchObject({ action: 'block', rule_index: 3 });
    expect(on('finacle', 'POST', '/custom/api/x/y')).toMatchObject({ action: 'allow', rule_index: 4 });
  });

  test('is total: odd inputs still return a decision', () => {
    const odd = [{ service: 'harbor', method: 'GET', api: 'no-slash', action: 'allow' } as ApiRule];
    const inputs = [
      { service: '', method: '', pathname: '' },
      { service: 'x', method: 'GET', pathname: '/' },
      { service: 'harbor', method: 'GET', pathname: '/no-slash' },
      { service: 'harbor', method: 'GET', pathname: undefined as unknown as string },
    ];
    for (const input of inputs) {
      const d = evaluateRule(odd, input);
      expect(['allow', 'block']).toContain(d.action);
      expect(d.rule_index === 'default' || typeof d.rule_index === 'number').toBe(true);
    }
  });
});

// ------------------------------------------------------------- validateRules

describe('validateRules', () => {
  test('[] is valid with no errors or warnings', () => {
    expect(validateRules([], SERVICES)).toEqual({ rules: [], errors: [], warnings: [] });
  });

  test('loader deny: the file must be an array of objects', () => {
    expect(errorsOf({})).toEqual(['file must be a JSON array of rules']);
    expect(errorsOf(null)).toHaveLength(1);
    expect(errorsOf(['x'])).toEqual(['rule 0: must be an object']);
  });

  test('loader deny: unknown service', () => {
    const errors = errorsOf([{ service: 'ledger', method: 'GET', api: '/x', action: 'block' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule 0');
    expect(errors[0]).toContain('unknown service');
  });

  test("service '*' is accepted", () => {
    expect(errorsOf([{ service: '*', method: 'GET', api: '/x', action: 'block' }])).toEqual([]);
  });

  test("loader deny: action 'deny' is not allow|block", () => {
    const errors = errorsOf([{ service: 'harbor', method: 'GET', api: '/x', action: 'deny' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^rule 0: action "deny" must be allow or block$/);
  });

  test("deny: method 'get' is a loader error, not a silent match", () => {
    const errors = errorsOf([{ service: 'harbor', method: 'get', api: '/x', action: 'block' }]);
    expect(errors).toEqual(['rule 0: method "get" must be upper case']);
    expect(errorsOf([{ service: 'harbor', method: 'FETCH', api: '/x', action: 'block' }])).toEqual([
      'rule 0: unknown method "FETCH"',
    ]);
  });

  test('every listed HTTP method is accepted', () => {
    for (const method of HTTP_METHODS) {
      expect(errorsOf([{ service: 'harbor', method, api: '/x', action: 'block' }])).toEqual([]);
    }
  });

  test('loader deny: duplicate rule', () => {
    const errors = errorsOf([
      { service: 'harbor', method: 'GET', api: '/x/:id', action: 'block' },
      { service: 'harbor', method: 'GET', api: '/x/:id', action: 'allow', reason: 'r' },
    ]);
    expect(errors).toEqual(['rule 1: duplicate of rule 0']);
  });

  test('loader deny: rule shadowed by an earlier {harbor, *, *, block}', () => {
    const errors = errorsOf([
      { service: 'harbor', method: '*', api: '*', action: 'block' },
      { service: 'harbor', method: 'POST', api: '/api/v1/forms/:id', action: 'allow', reason: 'r' },
      { service: 'rhythm', method: 'POST', api: '/api/v1/forms/:id', action: 'allow', reason: 'r' },
    ]);
    expect(errors).toEqual(['rule 1: never reached; shadowed by rule 0']);
  });

  test('shadowing follows template coverage', () => {
    const shadowed = (a: string, b: string) =>
      errorsOf([
        { service: 'harbor', method: 'POST', api: a, action: 'block' },
        { service: 'harbor', method: 'POST', api: b, action: 'block' },
      ]).length === 1;
    expect(shadowed('/a/*', '/a/b')).toBe(true);
    expect(shadowed('/a/*', '/a/:id/c')).toBe(true);
    expect(shadowed('/a/*', '/a/b/*')).toBe(true);
    expect(shadowed('/a/:id', '/a/b')).toBe(true);
    expect(shadowed('/a/:id/*', '/a/b/c/*')).toBe(true);
    expect(shadowed('/a/*', '/a')).toBe(false);
    expect(shadowed('/a/b', '/a/:id')).toBe(false);
    expect(shadowed('/a/b', '/a/b/*')).toBe(false);
    expect(shadowed('/a/b/*', '/a/*')).toBe(false);
    expect(shadowed('/a/:id', '/a/:id/*')).toBe(false);
    expect(shadowed('/a/*', '*')).toBe(false);
  });

  test('a narrower method or service after a wider one is not shadowed by the narrow one', () => {
    expect(
      errorsOf([
        { service: 'harbor', method: 'GET', api: '/x', action: 'block' },
        { service: 'harbor', method: '*', api: '/x', action: 'allow', reason: 'r' },
        { service: 'harbor', method: 'POST', api: '/y', action: 'block' },
        { service: '*', method: 'POST', api: '/y', action: 'block' },
      ]),
    ).toEqual([]);
  });

  test("loader deny: broad allow with api '*' without confirm_broad", () => {
    const errors = errorsOf([{ service: 'harbor', method: 'POST', api: '*', action: 'allow', reason: 'r' }]);
    expect(errors).toEqual(['rule 0: allow is too broad; set confirm_broad: true and a reason']);
  });

  test("loader deny: broad allow method '*' on '/x/*' without reason", () => {
    const errors = errorsOf([{ service: 'harbor', method: '*', api: '/x/*', action: 'allow', confirm_broad: true }]);
    expect(errors).toEqual(['rule 0: allow is too broad; set confirm_broad: true and a reason']);
    expect(errorsOf([{ service: 'harbor', method: '*', api: '/x/*', action: 'allow', confirm_broad: true, reason: '  ' }])).toHaveLength(1);
    expect(errorsOf([{ service: 'harbor', method: '*', api: '/x/*', action: 'allow', confirm_broad: false, reason: 'r' }])).toHaveLength(1);
  });

  test('a broad block needs no confirmation', () => {
    expect(errorsOf([{ service: 'harbor', method: '*', api: '/x/*', action: 'block' }])).toEqual([]);
  });

  test('confirm_broad with a reason loads', () => {
    const result = validateRules(
      [{ service: 'finacle', method: '*', api: '/custom/*', action: 'allow', confirm_broad: true, reason: 'reviewed' }],
      SERVICES,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.rules).toEqual([
      { service: 'finacle', method: '*', api: '/custom/*', action: 'allow', confirm_broad: true, reason: 'reviewed' },
    ]);
  });

  test('allow without a reason yields a warning, not an error', () => {
    const result = validateRules([{ service: 'bro', method: 'POST', api: '/dashboard/api/v1/dry-run', action: 'allow' }], SERVICES);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(['rule 0: allow has no reason']);
    expect(result.rules).toHaveLength(1);
  });

  test('loader deny: bad field types, unknown fields and malformed templates', () => {
    expect(errorsOf([{ service: 'harbor', method: 'GET', api: '/x', action: 'block', note: 'n' }])).toEqual([
      'rule 0: unknown field "note"',
    ]);
    expect(errorsOf([{ service: 'harbor', method: 'GET', api: '/x', action: 'block', confirm_broad: 'yes' }])).toEqual([
      'rule 0: confirm_broad must be a boolean',
    ]);
    expect(errorsOf([{ service: 'harbor', method: 'GET', api: '/x', action: 'block', reason: 1 }])).toEqual([
      'rule 0: reason must be a string',
    ]);
    expect(errorsOf([{ method: 'GET', api: '/x', action: 'block' }])).toEqual(['rule 0: service must be a string']);
    expect(errorsOf([{ service: 'harbor', method: 'GET', api: '/x?y=1', action: 'block' }])[0]).toContain('query string');
    for (const api of ['x', '/a/*/b', '/a//b', '/', '/a/:', '/a/*x', '']) {
      expect(errorsOf([{ service: 'harbor', method: 'GET', api, action: 'block' }])).toHaveLength(1);
    }
  });

  test('errors name every bad rule by its index', () => {
    const errors = errorsOf([
      { service: 'harbor', method: 'GET', api: '/ok', action: 'block' },
      { service: 'nope', method: 'GET', api: '/x', action: 'block' },
      { service: 'harbor', method: 'GET', api: '/y', action: 'deny' },
    ]);
    expect(errors.map((e) => e.split(':')[0])).toEqual(['rule 1', 'rule 2']);
  });
});

// ------------------------------------------------------------ loadRulesFile

describe('loadRulesFile', () => {
  let home: TestHome | undefined;
  afterEach(() => {
    home?.cleanup();
    home = undefined;
  });

  test('shipped resources/{ssfb,atspl,rtl}.api.rules.json equal [] and load cleanly', () => {
    home = makeTestHome();
    for (const entity of ENTITIES) {
      const shipped: unknown = JSON.parse(readFileSync(join(ROOT, 'resources', rulesFileName(entity)), 'utf8'));
      expect(shipped).toEqual([]);
      const services = home.registry.services(entity);
      expect(validateRules(shipped, services)).toEqual({ rules: [], errors: [], warnings: [] });
      const loaded = loadRulesFile(home.home, entity, services);
      expect(loaded.rules).toEqual([]);
      expect(loaded.warnings).toEqual([]);
      expect(loaded.file).toBe(`resources/${entity}.api.rules.json`);
    }
  });

  test('loader deny: an invalid file throws naming the entity, file and rule index', () => {
    home = makeTestHome();
    const file = join(home.home, 'resources', rulesFileName('atspl'));
    writeFileSync(
      file,
      JSON.stringify([
        { service: 'nope', method: 'GET', api: '/x', action: 'block' },
        { service: '*', method: 'get', api: '/y', action: 'block' },
      ]),
    );
    let caught: unknown;
    try {
      loadRulesFile(home.home, 'atspl', home.registry.services('atspl'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { keys: readonly string[] };
    expect(err.name).toBe('RegistryError');
    expect(err.keys).toEqual(['resources/atspl.api.rules.json']);
    expect(err.message).toContain('resources/atspl.api.rules.json');
    expect(err.message).toContain('entity atspl');
    expect(err.message).toContain('rule 0');
    expect(err.message).toContain('rule 1');
  });

  test('loader deny: error text never contains env values', () => {
    home = makeTestHome({ overrides: { TRIAGE_ENV_LABEL: 'label-sentinel-9f3a' } });
    writeFileSync(join(home.home, 'resources', rulesFileName('ssfb')), '[{"service":"harbor"}]');
    let message = '';
    try {
      loadRulesFile(home.home, 'ssfb', home.registry.services('ssfb'));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('rule 0');
    expect(message).not.toContain('label-sentinel-9f3a');
    for (const value of Object.values(home.env)) {
      if (value.length >= 6) expect(message).not.toContain(value);
    }
  });

  test('loader deny: a missing file or invalid JSON is a startup error', () => {
    home = makeTestHome();
    const file = join(home.home, 'resources', rulesFileName('rtl'));
    writeFileSync(file, '[{');
    expect(() => loadRulesFile(home!.home, 'rtl', [])).toThrow(/resources\/rtl\.api\.rules\.json \(entity rtl\) is not valid JSON/);
    rmSync(file);
    expect(() => loadRulesFile(home!.home, 'rtl', [])).toThrow(/resources\/rtl\.api\.rules\.json \(entity rtl\) is missing/);
  });

  test('warnings come back from the loader', () => {
    home = makeTestHome();
    writeFileSync(
      join(home.home, 'resources', rulesFileName('ssfb')),
      JSON.stringify([{ service: 'bro', method: 'POST', api: '/dashboard/api/v1/dry-run', action: 'allow' }]),
    );
    const loaded = loadRulesFile(home.home, 'ssfb', home.registry.services('ssfb'));
    expect(loaded.warnings).toEqual(['rule 0: allow has no reason']);
    expect(loaded.rules).toHaveLength(1);
  });
});
