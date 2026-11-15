import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { deploy } from './commands/deploy.js';
import { init } from './commands/init.js';
import { git } from './git.js';

process.env.ASF_HOME = mkdtempSync(join(tmpdir(), 'asf-home-'));
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'asf test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'asf@example.invalid';

let root: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'asf-product-'));
  out = join(mkdtempSync(join(tmpdir(), 'asf-deploy-')), 'log');
  init(root, 'demo');
  const project = join(root, '.factory/project.yaml');
  writeFileSync(project, readFileSync(project, 'utf8') + `deploy:\n  staging: ["node deploy.js staging"]\n  broken: ["exit 3"]\n`);
  writeFileSync(join(root, 'deploy.js'), "require('node:fs').appendFileSync(process.env.DEPLOY_LOG, `${process.argv[2]} with ${process.env.DEPLOY_TOKEN}\\n`);\n");
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  process.chdir(root);
  process.env.DEPLOY_LOG = out;
  process.env.DEPLOY_TOKEN = 'the-owners-token';
});

test('a deploy shows its plan first, runs with the owner\'s environment, and shows what changed since', () => {
  const plan = deploy('staging');
  assert.equal(plan.ran, false);
  assert.match(plan.text, /\$ node deploy\.js staging\n\nfirst deploy to staging\n\nRun again with --yes/);

  const r = deploy('staging', { yes: true });
  assert.ok(r.ok && r.ran);
  assert.equal(readFileSync(out, 'utf8'), 'staging with the-owners-token\n', 'the runner, not an agent, holds the credentials');

  writeFileSync(join(root, 'deploy.js'), "require('node:fs').appendFileSync(process.env.DEPLOY_LOG, 'changed\\n');\n");
  writeFileSync(join(root, 'README.md'), 'docs\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'change the deploy']);
  assert.match(deploy('staging').text, /read them first:\n {2}- deploy\.js$/m, 'only files that decide the deploy are listed');
});

test('a deploy runs only from a clean base branch, stops at a failing command, and knows its environments', () => {
  assert.throws(() => deploy('prod'), /no deploy commands for prod; environments: staging, broken/);
  const r = deploy('broken', { yes: true });
  assert.equal(r.ok, false);
  assert.match(r.text, /`exit 3` exited 3/);
  assert.match(deploy('broken').text, /first deploy to broken/, 'a failed deploy is not recorded');
  git(root, ['checkout', '-q', '-b', 'feature']);
  assert.throws(() => deploy('staging'), /check out main with a clean tree first/);
});
