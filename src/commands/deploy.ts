import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentBranch, git, isAncestor, isClean } from '../git.js';
import { matchesAny } from '../glob.js';
import { appendEvent } from '../runlog.js';
import { openProduct, UsageError } from './context.js';

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

/**
 * Deploys the base branch to one environment with the commands in `project.yaml`. The runner runs them, never an
 * agent, and outside the sandbox with the owner's own environment: that is where the credentials are, and no agent
 * ever sees them. Without `yes` it only shows what will run and which files that decide the deploy (the policy's
 * approval paths) changed since the last deploy there, for the owner to read first.
 */
export function deploy(env: string, opts: { yes?: boolean; root?: string } = {}): DeployResult {
  const { paths, project, policy } = openProduct(opts.root);
  const commands = project.deploy?.[env];
  const envs = Object.keys(project.deploy ?? {});
  if (!commands?.length) throw new UsageError(envs.length ? `no deploy commands for ${env}; environments: ${envs.join(', ')}` : 'no deploy commands in .factory/project.yaml (deploy: { <env>: [commands] })');
  const base = project.base_branch ?? 'main';
  if (currentBranch(paths.root) !== base || !isClean(paths.root)) throw new UsageError(`check out ${base} with a clean tree first; only what was released is deployed`);
  const commit = git(paths.root, ['rev-parse', 'HEAD']).trim();
  const last = load(paths.factory)[env];
  let since: string;
  if (!last) since = `first deploy to ${env}`;
  else if (!isAncestor(paths.root, last.commit)) since = `the last deploy to ${env} (${last.commit.slice(0, 12)}) is not in ${base}'s history`;
  else {
    const changed = git(paths.root, ['diff', '--name-only', last.commit, commit]).split('\n').filter((f) => f && matchesAny(f, policy.approval_paths));
    since = changed.length ? `changed since the last deploy (${last.commit.slice(0, 12)}), read them first:\n${changed.map((f) => `  - ${f}`).join('\n')}` : `nothing that decides the deploy changed since the last one (${last.commit.slice(0, 12)})`;
  }
  const plan = [`Deploy ${base} at ${commit.slice(0, 12)} to ${env}:`, ...commands.map((c) => `  $ ${c}`), '', since].join('\n');
  if (!opts.yes) return { env, commit, ran: false, ok: true, text: `${plan}\n\nRun again with --yes to deploy.` };

  const started = Date.now();
  for (const command of commands) {
    const r = spawnSync('sh', ['-c', command], { cwd: paths.root, stdio: 'inherit', env: process.env });
    if (r.status !== 0) {
      appendEvent(paths.runs, { at: new Date().toISOString(), item: `deploy:${env}`, step: 'deploy', kind: 'item', outcome: 'failed', duration_ms: Date.now() - started, detail: `${command} exited ${r.status ?? r.signal}` });
      return { env, commit, ran: true, ok: false, text: `deploy to ${env} failed: \`${command}\` exited ${r.status ?? r.signal}` };
    }
  }
  writeFileSync(file(paths.factory), JSON.stringify({ ...load(paths.factory), [env]: { commit, at: new Date().toISOString() } }, null, 2) + '\n');
  appendEvent(paths.runs, { at: new Date().toISOString(), item: `deploy:${env}`, step: 'deploy', kind: 'item', outcome: 'deployed', duration_ms: Date.now() - started, detail: commit });
  return { env, commit, ran: true, ok: true, text: `deployed ${commit.slice(0, 12)} to ${env}` };
}
