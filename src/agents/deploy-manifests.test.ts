import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestHome, REPO_ROOT, type TestHome } from '../../test/support/home.ts';
import { throwingDeps } from '../../test/support/fake-tool-context.ts';
import { codeWalkerMounts } from './delegates/code-walker.ts';
import { investigatorMounts } from './delegates/investigator.ts';
import { deployManifestLines } from './deploy-manifests.ts';
import { loadKnowledge, type Knowledge } from './skills.ts';

const RUN = 'run_deploy_manifests_0001';
const RTL_PROD = '- Deploy manifests for rtl: repo k8s-manifests, folder environments/vance-core/prod/eu-west-2 (start path and path_glob with it).';

let knowledge: Knowledge;
let reposDir: string;
const homes: TestHome[] = [];

beforeAll(() => {
  knowledge = loadKnowledge(join(REPO_ROOT, 'knowledge'));
  reposDir = mkdtempSync(join(tmpdir(), 'triage-repos-'));
});

afterAll(() => {
  for (const h of homes.splice(0)) h.cleanup();
  rmSync(reposDir, { recursive: true, force: true });
});

function home(overrides: Record<string, string> = {}): TestHome {
  const h = makeTestHome({ overrides: { TRIAGE_REPOS_DIR: reposDir, ...overrides } });
  homes.push(h);
  return h;
}

describe('deployManifestLines', () => {
  test('names the repo, and the folder when there is one', () => {
    const h = home();
    const [ssfb, rtl] = deployManifestLines(h.config, h.registry, ['ssfb', 'rtl']);
    expect(ssfb).toStartWith('- Deploy manifests for ssfb: repo prod-ssfb-aspora-argo. ');
    expect(rtl).toStartWith(RTL_PROD);
  });

  test('a stage .env gives the stage repos', () => {
    const h = home({ SSFB_INFRA_REPO: 'non-prod-aspora-argo', RTL_INFRA_REPO: 'k8s-manifests:environments/vance-core/stage/ap-south-1' });
    const [ssfb, rtl] = deployManifestLines(h.config, h.registry, ['ssfb', 'rtl']);
    expect(ssfb).toStartWith('- Deploy manifests for ssfb: repo non-prod-aspora-argo. ');
    expect(rtl).toContain('folder environments/vance-core/stage/ap-south-1');
  });

  test('blank or pinned for another entity is not configured, with the reason', () => {
    const h = home({ ATSPL_INFRA_REPO: '', RTL_INFRA_REPO: 'prod-ssfb-aspora-argo' });
    const [atspl, rtl] = deployManifestLines(h.config, h.registry, ['atspl', 'rtl']);
    expect(atspl).toStartWith('- Deploy manifests for atspl: not configured (ATSPL_INFRA_REPO is blank).');
    expect(rtl).toContain('RTL_INFRA_REPO names prod-ssfb-aspora-argo, which is not pinned for rtl');
  });
});

describe('delegates', () => {
  test('an investigator sees its own entity only; code_walker sees every enabled entity', () => {
    const h = home();
    const env = { config: h.config, registry: h.registry, deps: throwingDeps(), knowledge };
    const rtl = investigatorMounts('rtl', RUN, { deep: true, env }).instructions;
    expect(rtl).toContain(RTL_PROD);
    expect(rtl).not.toContain('Deploy manifests for ssfb');
    const walker = codeWalkerMounts(RUN, { env }).instructions;
    for (const e of h.registry.enabledEntities()) expect(walker).toContain(`- Deploy manifests for ${e}:`);
  });
});
