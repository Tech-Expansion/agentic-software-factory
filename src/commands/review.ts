import { loadBacklog, setStatus } from '../backlog.js';
import { commitAll, currentBranch, git, isClean, removeWorktree } from '../git.js';
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

/** The user's approval: marks the item done on its branch, merges the branch, removes the worktree. */
export function approve(id: string, root?: string): { merged: string; flags: string[] } {
  const { product, state, st } = reviewItem(id, root);
  const { paths, project } = product;
  if (st?.state !== 'review') throw new UsageError(`${id} is not waiting for review (${st?.state ?? 'never run'})`);
  const base = project.base_branch ?? 'main';
  if (currentBranch(paths.root) !== base) throw new UsageError(`check out ${base} first`);
  if (!isClean(paths.root)) throw new UsageError('commit or stash your changes on the base branch first');

  const item = loadBacklog(join(st.worktree, 'backlog')).items.find((i) => i.id === id);
  if (!item) throw new UsageError(`${id} not found in the item's worktree`);
  setStatus(item.file, 'done');
  commitAll(st.worktree, `chore(backlog): mark ${id} done\n`);
  git(paths.root, ['merge', '--no-ff', '-q', st.branch, '-m', `Merge ${id}: ${item.title}`]);
  removeWorktree(paths.root, st.worktree, st.branch);
  delete state.items[id];
  saveState(paths.state, state);
  appendEvent(paths.runs, { at: new Date().toISOString(), item: id, step: 'approve', kind: 'item', outcome: 'done' });
  return { merged: st.branch, flags: st.flags ?? [] };
}

/** Sends an item in review back with the user's reason; the next run continues from its worktree. */
export function reject(id: string, reason: string, root?: string): void {
  const { product, state, st } = reviewItem(id, root);
  if (st?.state !== 'review') throw new UsageError(`${id} is not waiting for review (${st?.state ?? 'never run'})`);
  if (!reason.trim()) throw new UsageError('give a reason: it is what the builder gets as feedback');
  state.items[id] = { ...st, state: 'rework', feedback: `Rejected by the user: ${reason}`, updated_at: new Date().toISOString() };
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
    ...(st.feedback ? ['', st.feedback] : []),
  ].join('\n');
}
