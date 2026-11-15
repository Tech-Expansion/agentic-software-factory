import { loadBacklog, setStatus, subject } from '../backlog.js';
import { spawnSync } from 'node:child_process';
import { loadClarification } from '../clarify.js';
import { productionBranch } from '../engine.js';
import { deployDev, type DeployResult } from './deploy.js';
import { commitAll, fastForward, git, isAncestor, removeWorktree } from '../git.js';
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

/**
 * The owner's approval. For a plan waiting in plan-review, it lets the build start. For a built item, it marks the
 * item done on its branch and merges it into the base branch, the development line. The merge is made in the item's
 * own worktree and the base branch then moves forward to it, so the owner's checkout never has to be clean or on it.
 */
export function approve(id: string, root?: string): { merged: string; into: string; flags: string[]; dev?: DeployResult } {
  const { product, state, st } = reviewItem(id, root);
  const { paths, project } = product;
  if (st?.state === 'plan-review' && st.plan) {
    state.items[id] = { ...st, state: 'rework', plan: { ...st.plan, approved: new Date().toISOString(), by: 'owner' }, reason: undefined, updated_at: new Date().toISOString() };
    saveState(paths.state, state);
    appendEvent(paths.runs, { at: new Date().toISOString(), item: id, step: 'approve', kind: 'item', outcome: 'plan approved' });
    return { merged: '', into: 'plan', flags: [] };
  }
  if (st?.state !== 'review') throw new UsageError(`${id} is not waiting for review (${st?.state ?? 'never run'})`);
  const base = project.base_branch ?? 'main';

  const item = loadBacklog(join(st.worktree, 'backlog')).items.find((i) => i.id === id);
  if (!item) throw new UsageError(`${id} not found in the item's worktree`);
  setStatus(item.file, 'done');
  commitAll(st.worktree, `${subject(item, `chore(backlog): mark ${id} done`)}\n`);
  git(st.worktree, ['checkout', '-q', '--detach', base]);
  const merged = spawnSync('git', ['merge', '--no-ff', '-q', st.branch, '-m', subject(item, `Merge ${id}: ${item.title}`)], { cwd: st.worktree, encoding: 'utf8' });
  if (merged.status !== 0) {
    git(st.worktree, ['merge', '--abort'], true);
    // The work is started again from the base branch on retry: a fresh worktree, new tests, the approved plan kept.
    removeWorktree(paths.root, st.worktree, st.branch);
    const reason = `does not merge cleanly into ${base}; \`asf decide ${id} retry\` builds it again on top of it:\n${(merged.stdout + merged.stderr).trim()}`;
    state.items[id] = { ...st, state: 'blocked', reason, tests: undefined, feedback: undefined, updated_at: new Date().toISOString() };
    saveState(paths.state, state);
    throw new UsageError(`${id} ${reason}`);
  }
  const commit = git(st.worktree, ['rev-parse', 'HEAD']).trim();
  try {
    fastForward(paths.root, base, commit);
  } catch (err) {
    git(st.worktree, ['checkout', '-q', st.branch]);
    throw new UsageError(`${id} could not move ${base} forward; uncommitted changes there touch the same files. Commit them, then \`asf decide ${id} approve\`:\n${(err as Error).message}`);
  }
  removeWorktree(paths.root, st.worktree, st.branch);
  state.items[id] = { ...st, state: 'merged', commit, reason: undefined, updated_at: new Date().toISOString() };
  saveState(paths.state, state);
  appendEvent(paths.runs, { at: new Date().toISOString(), item: id, step: 'approve', kind: 'item', outcome: 'merged', detail: base });
  // A dev deploy that fails is logged and leaves the merge as it is; the next merge deploys again.
  return { merged: st.branch, into: base, flags: st.flags ?? [], dev: deployDev(root) };
}

/** What the next release brings into production: items merged into the base branch and not released yet. */
export function releasable(root?: string): string[] {
  const { state } = reviewItem('', root);
  return Object.entries(state.items).filter(([, v]) => v.state === 'merged').map(([id]) => id).sort();
}

/**
 * Items whose merge production now contains are done; with a remote, after taking in what the owner merged there.
 * Returns their ids.
 */
export function markReleased(root?: string): string[] {
  const { product, state } = reviewItem('', root);
  const { paths, project } = product;
  const merged = Object.entries(state.items).filter(([, v]) => v.state === 'merged');
  if (!merged.length) return [];
  const production = productionBranch(paths.root, project);
  if (project.remote) {
    const remote = `refs/remotes/${project.remote}/${production}`;
    git(paths.root, ['fetch', '-q', project.remote, `+refs/heads/${production}:${remote}`], true);
    const theirs = git(paths.root, ['rev-parse', '-q', '--verify', remote], true).trim();
    if (theirs && theirs !== git(paths.root, ['rev-parse', production]).trim() && isAncestor(paths.root, production, theirs)) fastForward(paths.root, production, theirs);
  }
  const done = merged.filter(([, v]) => v.commit && isAncestor(paths.root, v.commit, production)).map(([id]) => id).sort();
  for (const id of done) delete state.items[id];
  if (done.length) saveState(paths.state, state);
  for (const id of done) appendEvent(paths.runs, { at: new Date().toISOString(), item: id, step: 'release', kind: 'item', outcome: 'done', detail: production });
  return done;
}

/** The release notes: each item's title and what the product owner understood it to mean. */
export function releaseNotes(items: string[], root?: string): string {
  const { product } = reviewItem('', root);
  const backlog = loadBacklog(product.paths.backlog).items;
  const lines = items.map((id) => {
    const understood = loadClarification(product.paths.factory, id)?.understood;
    return `- **${id}** ${backlog.find((i) => i.id === id)?.title ?? ''}${understood ? `: ${understood}` : ''}`;
  });
  return [`Releases ${items.join(', ')}.`, '', ...lines, '', 'Merge with a merge commit, not a squash or a rebase, so asf can tell what was released.'].join('\n');
}

export interface ReleaseResult {
  items: string[];
  /** The release commit on production, when it was merged here. */
  commit?: string;
  /** The release pull request, when there is a remote: the owner merges it. */
  pr?: string;
}

/**
 * The owner's release. With a remote, it pushes the base branch and opens or updates the pull request into production,
 * which the owner merges; without one, it merges the base branch into production here.
 */
export function release(root?: string): ReleaseResult {
  const { product } = reviewItem('', root);
  const { paths, project } = product;
  markReleased(root);
  const items = releasable(root);
  if (!items.length) return { items };
  const base = project.base_branch ?? 'main';
  const production = productionBranch(paths.root, project);
  const notes = releaseNotes(items, root);
  if (project.remote) return { items, pr: releasePullRequest(paths.root, project.remote, base, production, items, notes) };

  // Production only ever takes the base branch in, so the base branch already contains it and the release is the
  // base branch's tree on top of production.
  const commit = git(paths.root, ['commit-tree', `${base}^{tree}`, '-p', production, '-p', base, '-F', '-'], false, `Release ${items.join(', ')}\n\n${notes}\n`).trim();
  fastForward(paths.root, production, commit);
  markReleased(root);
  return { items, commit: commit.slice(0, 12) };
}

function gh(cwd: string, args: string[]): string {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new UsageError('the release pull request needs the GitHub CLI (gh), signed in; or open one from the base branch into production yourself');
  if (r.status !== 0) throw new UsageError(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function releasePullRequest(root: string, remote: string, base: string, production: string, items: string[], notes: string): string {
  git(root, ['push', '-q', remote, `refs/heads/${base}:refs/heads/${base}`]);
  if (!git(root, ['ls-remote', '--heads', remote, production]).trim()) git(root, ['push', '-q', remote, `refs/heads/${production}:refs/heads/${production}`]);
  const title = `Release ${items.join(', ')}`;
  const open = JSON.parse(gh(root, ['pr', 'list', '--head', base, '--base', production, '--state', 'open', '--json', 'number,url'])) as { number: number; url: string }[];
  if (open[0]) {
    gh(root, ['pr', 'edit', String(open[0].number), '--title', title, '--body', notes]);
    return open[0].url;
  }
  return gh(root, ['pr', 'create', '--head', base, '--base', production, '--title', title, '--body', notes]);
}

/** Sends an item in review back with the user's reason; the next run continues from its worktree. A rejected plan is
 * written again with the reason. */
export function reject(id: string, reason: string, root?: string): void {
  const { product, state, st } = reviewItem(id, root);
  if (st?.state === 'merged') throw new UsageError(`${id} is already merged into ${product.project.base_branch ?? 'main'} and not live yet; ask for the change as a new request, and it goes out in the same release`);
  if (st?.state !== 'review' && st?.state !== 'plan-review') throw new UsageError(`${id} is not waiting for review (${st?.state ?? 'never run'})`);
  if (!reason.trim()) throw new UsageError('give a reason: it is what the team gets as feedback');
  const plan = st.state === 'plan-review' ? undefined : st.plan;
  state.items[id] = { ...st, state: 'rework', plan, feedback: `Rejected by the user: ${reason}`, updated_at: new Date().toISOString() };
  saveState(product.paths.state, state);
  appendEvent(product.paths.runs, { at: new Date().toISOString(), item: id, step: 'reject', kind: 'item', outcome: 'rework', detail: reason });
}

/**
 * Lets a blocked item run again, keeping its worktree and the last feedback. The owner's answer to the team's question,
 * if they gave one, goes to the team with it, and an item that went up the team can go up again.
 */
export function retry(id: string, root?: string, answer?: string): void {
  const { product, state, st } = reviewItem(id, root);
  if (st?.state !== 'blocked') throw new UsageError(`${id} is not blocked (${st?.state ?? 'never run'})`);
  const feedback = answer?.trim() ? `${st.feedback ? `${st.feedback}\n\n` : ''}The owner decided: ${answer.trim()}\n(asked: ${st.reason ?? ''})` : st.feedback;
  state.items[id] = { ...st, state: 'rework', feedback, escalated: answer?.trim() ? undefined : st.escalated, updated_at: new Date().toISOString() };
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
    ...(st.state === 'plan-review' && st.plan ? ['', `Plan, waiting for \`asf decide ${id} approve\` or \`asf decide ${id} reject <reason>\`:`, '', st.plan.text] : []),
    ...(st.feedback ? ['', st.feedback] : []),
  ].join('\n');
}
