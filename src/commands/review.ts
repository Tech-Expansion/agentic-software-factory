import { loadBacklog, setStatus, subject } from '../backlog.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { commitAll, currentBranch, ensureWorktree, git, isClean, removeWorktree } from '../git.js';
import { join, relative } from 'node:path';
import { appendEvent } from '../runlog.js';
import { loadState, saveState } from '../state.js';
import { openProduct, UsageError } from './context.js';

function reviewItem(id: string, root?: string) {
  const product = openProduct(root);
  const state = loadState(product.paths.state);
  const st = state.items[id];
  return { product, state, st };
}

/** The integration branch's own worktree, where items merge while the owner's checkout stays on the base branch. */
function integrationWorktree(root: string, factory: string, branch: string, base: string): string {
  const path = join(factory, 'worktrees', '_integration');
  if (!git(root, ['branch', '--list', branch]).trim()) git(root, ['branch', branch, base]);
  ensureWorktree(root, path, branch, base);
  return path;
}

/**
 * The owner's approval. For a plan waiting in plan-review, it lets the build start. For a built item, it marks the
 * item done on its branch and merges it: into the integration branch when there is one, otherwise into the base
 * branch.
 */
export function approve(id: string, root?: string): { merged: string; into: string; flags: string[] } {
  const { product, state, st } = reviewItem(id, root);
  const { paths, project } = product;
  if (st?.state === 'plan-review' && st.plan) {
    state.items[id] = { ...st, state: 'rework', plan: { ...st.plan, approved: new Date().toISOString() }, reason: undefined, updated_at: new Date().toISOString() };
    saveState(paths.state, state);
    appendEvent(paths.runs, { at: new Date().toISOString(), item: id, step: 'approve', kind: 'item', outcome: 'plan approved' });
    return { merged: '', into: 'plan', flags: [] };
  }
  if (st?.state !== 'review') throw new UsageError(`${id} is not waiting for review (${st?.state ?? 'never run'})`);
  const base = project.base_branch ?? 'main';
  const integration = project.integration_branch;
  if (!integration) {
    if (currentBranch(paths.root) !== base) throw new UsageError(`check out ${base} first`);
    if (!isClean(paths.root)) throw new UsageError('commit or stash your changes on the base branch first');
  }

  const item = loadBacklog(join(st.worktree, 'backlog')).items.find((i) => i.id === id);
  if (!item) throw new UsageError(`${id} not found in the item's worktree`);
  setStatus(item.file, 'done');
  commitAll(st.worktree, `${subject(item, `chore(backlog): mark ${id} done`)}\n`);
  const target = integration ? integrationWorktree(paths.root, paths.factory, integration, base) : paths.root;
  const merged = spawnSync('git', ['merge', '--no-ff', '-q', st.branch, '-m', subject(item, `Merge ${id}: ${item.title}`)], { cwd: target, encoding: 'utf8' });
  if (merged.status !== 0) {
    git(target, ['merge', '--abort'], true);
    // The work is started again from the target on retry: a fresh worktree, new tests, the approved plan kept.
    removeWorktree(paths.root, st.worktree, st.branch);
    const reason = `does not merge cleanly into ${integration ?? base}; \`asf retry ${id}\` builds it again on top of it:\n${(merged.stdout + merged.stderr).trim()}`;
    state.items[id] = { ...st, state: 'blocked', reason, tests: undefined, feedback: undefined, updated_at: new Date().toISOString() };
    saveState(paths.state, state);
    throw new UsageError(`${id} ${reason}`);
  }
  removeWorktree(paths.root, st.worktree, st.branch);
  if (integration) state.items[id] = { ...st, state: 'merged', reason: undefined, updated_at: new Date().toISOString() };
  else delete state.items[id];
  saveState(paths.state, state);
  appendEvent(paths.runs, { at: new Date().toISOString(), item: id, step: 'approve', kind: 'item', outcome: integration ? 'merged' : 'done', detail: integration });
  return { merged: st.branch, into: integration ?? base, flags: st.flags ?? [] };
}

/** What `asf release` would bring into the base branch. */
export function releasable(root?: string): string[] {
  const { state } = reviewItem('', root);
  return Object.entries(state.items).filter(([, v]) => v.state === 'merged').map(([id]) => id).sort();
}

/** The owner's release: merges the integration branch into the base branch, in the owner's checkout. */
export function release(root?: string): { items: string[]; commit?: string } {
  const { product, state } = reviewItem('', root);
  const { paths, project } = product;
  const integration = project.integration_branch;
  if (!integration) throw new UsageError('no integration_branch in .factory/project.yaml; approved items merge into the base branch directly');
  const base = project.base_branch ?? 'main';
  if (currentBranch(paths.root) !== base) throw new UsageError(`check out ${base} first`);
  if (!isClean(paths.root)) throw new UsageError('commit or stash your changes on the base branch first');
  const items = releasable(root);
  if (!items.length) return { items };
  git(paths.root, ['merge', '--no-ff', '-q', integration, '-m', `Release ${items.join(', ')}`]);
  // The integration branch catches up with the release commit, so the next items start from what was shipped.
  const wt = join(paths.factory, 'worktrees', '_integration');
  if (existsSync(wt)) git(wt, ['merge', '--ff-only', '-q', base]);
  else git(paths.root, ['branch', '-f', integration, base]);
  for (const id of items) delete state.items[id];
  saveState(paths.state, state);
  for (const id of items) appendEvent(paths.runs, { at: new Date().toISOString(), item: id, step: 'release', kind: 'item', outcome: 'done' });
  return { items, commit: git(paths.root, ['rev-parse', '--short', 'HEAD']).trim() };
}

/** Sends an item in review back with the user's reason; the next run continues from its worktree. A rejected plan is
 * written again with the reason. */
export function reject(id: string, reason: string, root?: string): void {
  const { product, state, st } = reviewItem(id, root);
  if (st?.state !== 'review' && st?.state !== 'plan-review') throw new UsageError(`${id} is not waiting for review (${st?.state ?? 'never run'})`);
  if (!reason.trim()) throw new UsageError('give a reason: it is what the team gets as feedback');
  const plan = st.state === 'plan-review' ? undefined : st.plan;
  state.items[id] = { ...st, state: 'rework', plan, feedback: `Rejected by the user: ${reason}`, updated_at: new Date().toISOString() };
  saveState(product.paths.state, state);
  appendEvent(product.paths.runs, { at: new Date().toISOString(), item: id, step: 'reject', kind: 'item', outcome: 'rework', detail: reason });
}

/** Lets a blocked item run again, keeping its worktree and the last feedback. */
export function retry(id: string, root?: string): void {
  const { product, state, st } = reviewItem(id, root);
  if (st?.state !== 'blocked') throw new UsageError(`${id} is not blocked (${st?.state ?? 'never run'})`);
  state.items[id] = { ...st, state: 'rework', updated_at: new Date().toISOString() };
  saveState(product.paths.state, state);
}

/** Where to look at an item's work before deciding. */
export function describe(id: string): string {
  const { product, st } = reviewItem(id);
  if (!st) throw new UsageError(`${id} has not run`);
  const base = product.project.base_branch ?? 'main';
  return [
    `${id}: ${st.state}${st.reason ? ` (${st.reason})` : ''}`,
    `branch ${st.branch}, worktree ${relative(process.cwd(), st.worktree) || '.'}`,
    `diff: git diff ${base}...${st.branch}`,
    ...(st.flags?.length ? [`needs your attention: ${st.flags.join(', ')}`] : []),
    ...(st.state === 'plan-review' && st.plan ? ['', 'Plan, waiting for `asf approve` or `asf reject`:', '', st.plan.text] : []),
    ...(st.feedback ? ['', st.feedback] : []),
  ].join('\n');
}
