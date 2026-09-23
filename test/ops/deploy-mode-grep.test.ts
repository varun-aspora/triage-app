// D32: the deploy mode is read in pre-flight only. This scans src/ with the
// same rules and allowlist as test/guards/source-rules.test.ts (T01.8) and
// also checks that the allowed files really are the ones that match.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOY_MODE_KEY } from '../../src/config/keys.ts';
import { DEPLOY_MODE_ENV } from '../../src/ops/preflight.ts';
import { SOURCE_RULES, checkSource, formatViolation, srcFiles, stripComments } from '../guards/rules.ts';
import { REPO_ROOT } from '../support/home.ts';

const RULE_IDS = ['deploy-mode-key', 'deploy-mode-accessor'];
const rules = SOURCE_RULES.filter((r) => RULE_IDS.includes(r.id));

function filesMatching(re: RegExp): string[] {
  return srcFiles(REPO_ROOT).filter((p) => re.test(stripComments(readFileSync(join(REPO_ROOT, p), 'utf8'))));
}

describe('deploy mode is read in pre-flight only', () => {
  test('both T01.8 rules are present', () => {
    expect(rules.map((r) => r.id).sort()).toEqual([...RULE_IDS].sort());
  });

  test('no src/ file breaks the deploy-mode rules', () => {
    const violations = srcFiles(REPO_ROOT).flatMap((path) =>
      checkSource({ path, text: readFileSync(join(REPO_ROOT, path), 'utf8') }, rules),
    );
    expect(violations.map(formatViolation)).toEqual([]);
  });

  test('TRIAGE_DEPLOY_MODE matches only src/config/keys.ts and src/ops/preflight.ts', () => {
    expect(filesMatching(/TRIAGE_DEPLOY_MODE/)).toEqual(['src/config/keys.ts', 'src/ops/preflight.ts']);
  });

  test('deployModeForPreflight matches only src/config/env.ts and src/ops/preflight.ts', () => {
    expect(filesMatching(/\bdeployModeForPreflight\b/)).toEqual(['src/config/env.ts', 'src/ops/preflight.ts']);
  });

  test('preflight names the same key as keys.ts', () => {
    expect(DEPLOY_MODE_ENV).toBe(DEPLOY_MODE_KEY);
  });

  test('the steps file does not read the mode', () => {
    const text = stripComments(readFileSync(join(REPO_ROOT, 'src/ops/preflight-steps.ts'), 'utf8'));
    expect(text).not.toMatch(/TRIAGE_DEPLOY_MODE|deployModeForPreflight/);
  });

  test('the rules flag a new reader', () => {
    const bad = checkSource({ path: 'src/ops/preflight-steps.ts', text: "import { deployModeForPreflight } from '../config/env.ts';\nconst k = 'TRIAGE_DEPLOY_MODE';\n" }, rules);
    expect(bad.map((v) => [v.rule, v.line])).toEqual([
      ['deploy-mode-key', 2],
      ['deploy-mode-accessor', 1],
    ]);
  });
});
