import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatChecks, runChecks } from '../checks.js';
import { productionBranch } from '../engine.js';
import { git, isAncestor } from '../git.js';
import { matchesAny } from '../glob.js';
import { appendEvent } from '../runlog.js';
import { openProduct, UsageError, type Product } from './context.js';

/** The commit each environment last got, so the next deploy can show what changed since. */
type Deploys = Record<string, { commit: string; at: string }>;

const file = (factory: string) => join(factory, 'deploys.json');
const load = (factory: string): Deploys => (existsSync(file(factory)) ? (JSON.parse(readFileSync(file(factory), 'utf8')) as Deploys) : {});

export interface DeployResult {
  env: string;
  commit: string;
  /** False when it only showed the plan (without `yes`). */
  ran: boolean;
  ok: boolean;
  text: string;
}

/** A worktree of its own for each environment, at the commit it deploys: the owner's checkout can be anywhere. */
function deployTree(paths: Product['paths'], env: string, commit: string): string {
  const wt = join(paths.worktrees, `_deploy-${env}`);
  if (!existsSync(wt)) git(paths.root, ['worktree', 'add', '-q', '--detach', wt, commit]);
  else {
    git(wt, ['checkout', '-q', '--force', '--detach', commit]);
    git(wt, ['clean', '-q', '-fd']);
  }
  return wt;
}

function record(paths: Product['paths'], env: string, commit: string, started: number, failed?: string): void {
  if (!failed) writeFileSync(file(paths.factory), JSON.stringify({ ...load(paths.factory), [env]: { commit, at: new Date().toISOString() } }, null, 2) + '\n');
  appendEvent(paths.runs, { at: new Date().toISOString(), item: `deploy:${env}`, step: 'deploy', kind: 'item', outcome: failed ? 'failed' : 'deployed', duration_ms: Date.now() - started, detail: failed ?? commit });
}

/**
 * Deploys one environment with the commands in `project.yaml`: dev gets the base branch, every other environment
 * production, so only what the owner released goes live. The runner runs them, never an agent, and outside the
 * sandbox with the owner's own environment: that is where the credentials are, and no agent ever sees them. Without
 * `yes` it only shows what will run and which files that decide the deploy (the policy's approval paths) changed
 * since the last deploy there, for the owner to read first.
 */
export function deploy(env: string, opts: { yes?: boolean; root?: string } = {}): DeployResult {
  const { paths, project, policy } = openProduct(opts.root);
  const commands = project.deploy?.[env];
  const envs = Object.keys(project.deploy ?? {});
  if (!commands?.length) throw new UsageError(envs.length ? `no deploy commands for ${env}; environments: ${envs.join(', ')}` : 'no deploy commands in .factory/project.yaml (deploy: { <env>: [commands] })');
  const ref = env === 'dev' ? (project.base_branch ?? 'main') : productionBranch(paths.root, project);
  const commit = git(paths.root, ['rev-parse', ref]).trim();
  const last = load(paths.factory)[env];
  let since: string;
  if (!last) since = `first deploy to ${env}`;
  else if (!isAncestor(paths.root, last.commit, commit)) since = `the last deploy to ${env} (${last.commit.slice(0, 12)}) is not in ${ref}'s history`;
  else {
    const changed = git(paths.root, ['diff', '--name-only', last.commit, commit]).split('\n').filter((f) => f && matchesAny(f, policy.approval_paths));
    since = changed.length ? `changed since the last deploy (${last.commit.slice(0, 12)}), read them first:\n${changed.map((f) => `  - ${f}`).join('\n')}` : `nothing that decides the deploy changed since the last one (${last.commit.slice(0, 12)})`;
  }
  const plan = [`Deploy ${ref} at ${commit.slice(0, 12)} to ${env}:`, ...commands.map((c) => `  $ ${c}`), '', since].join('\n');
  if (!opts.yes) return { env, commit, ran: false, ok: true, text: `${plan}\n\nRun again with --yes to deploy.` };

  const started = Date.now();
  const cwd = deployTree(paths, env, commit);
  for (const command of commands) {
    const r = spawnSync(command, { shell: true, cwd, stdio: 'inherit', env: process.env });
    if (r.status !== 0) {
      record(paths, env, commit, started, `${command} exited ${r.status ?? r.signal}`);
      return { env, commit, ran: true, ok: false, text: `deploy to ${env} failed: \`${command}\` exited ${r.status ?? r.signal}` };
    }
  }
  record(paths, env, commit, started);
  return { env, commit, ran: true, ok: true, text: `deployed ${commit.slice(0, 12)} to ${env}` };
}

/**
 * After a merge into the base branch, the dev environment deploys itself as `dev_deploy` says, without asking the
 * owner. `push` pushes the base branch and leaves the deploy to the hosting or CI. `commands` runs `deploy.dev` here,
 * sandboxed like the checks (it runs code the agents wrote): it sees only the secrets named in `env` and reaches only
 * the package registries and the hosts in `network`. Returns nothing when dev does not deploy itself.
 */
export function deployDev(root?: string): DeployResult | undefined {
  const { paths, project, policy } = openProduct(root);
  const dev = project.dev_deploy;
  if (!dev) return undefined;
  const base = project.base_branch ?? 'main';
  const commit = git(paths.root, ['rev-parse', base]).trim();
  const started = Date.now();
  let failed: string | undefined;
  if (dev.run === 'push') {
    if (!project.remote) failed = 'dev_deploy: push needs a remote in .factory/project.yaml';
    else {
      const r = spawnSync('git', ['push', '-q', project.remote, `refs/heads/${base}:refs/heads/${base}`], { cwd: paths.root, encoding: 'utf8' });
      if (r.status !== 0) failed = `git push to ${project.remote} failed: ${(r.stderr || r.stdout).trim()}`;
    }
  } else {
    const commands = project.deploy?.dev;
    if (!commands?.length) failed = 'dev_deploy: commands needs deploy.dev commands in .factory/project.yaml';
    else {
      const allow = dev.env ?? [];
      const sandbox = { ...policy.sandbox, network_allow: [...policy.sandbox.network_allow, ...(dev.network ?? [])], secret_env: policy.sandbox.secret_env.filter((n) => !allow.includes(n)) };
      const results = runChecks(deployTree(paths, 'dev', commit), commands, sandbox, undefined, allow);
      if (!results.every((r) => r.ok)) failed = `deploy.dev failed:\n${formatChecks(results)}`;
    }
  }
  record(paths, 'dev', commit, started, failed);
  return { env: 'dev', commit, ran: true, ok: !failed, text: failed ? `dev deploy of ${commit.slice(0, 12)} failed: ${failed}` : `deployed ${commit.slice(0, 12)} to dev` };
}
