import { loadBacklog, nextReady, type BacklogItem } from '../backlog.js';
import { currentBranch, isRepo } from '../git.js';
import { runItem, type EngineContext, type ItemOutcome } from '../engine.js';
import { loadState } from '../state.js';
import { notify } from '../notify.js';
import { openProduct, runtimes, UsageError } from './context.js';
import { approve } from './review.js';

export interface RunOptions {
  item?: string;
  all?: boolean;
  /** The product root; found from the current directory when unset. */
  root?: string;
  log?: (msg: string) => void;
  /** For tests. */
  context?: Partial<EngineContext>;
}

/** Builds the next ready item, a given item, or (with `all`) every ready item until one blocks or none is left. */
export async function run(opts: RunOptions = {}): Promise<ItemOutcome[]> {
  const product = openProduct(opts.root);
  const { paths, project } = product;
  if (!isRepo(paths.root)) throw new UsageError(`${paths.root} is not a git repository`);
  const base = project.base_branch ?? 'main';
  if (currentBranch(paths.root) !== base) throw new UsageError(`check out ${base} first; items branch from it`);
  const ctx: EngineContext = { ...product, runtime: (n) => runtimes[n], log: opts.log, ...opts.context };

  const outcomes: ItemOutcome[] = [];
  for (;;) {
    const { items, errors } = loadBacklog(paths.backlog);
    if (errors.length) throw new UsageError(`fix the backlog first:\n  ${errors.join('\n  ')}`);
    let item: BacklogItem | undefined;
    if (opts.item) {
      item = items.find((i) => i.id === opts.item);
      if (!item) throw new UsageError(`no backlog item ${opts.item}`);
      const s = loadState(paths.state).items[item.id]?.state;
      if (s === 'review' || s === 'in-progress' || s === 'plan-review' || s === 'merged') throw new UsageError(`${item.id} is ${s}`);
      if (item.status !== 'ready') throw new UsageError(`${item.id} is ${item.status}, not ready`);
    } else {
      item = nextReady(items, loadState(paths.state));
    }
    if (!item) break;
    let outcome = await runItem(ctx, item);
    // With an integration branch, an item nothing flagged merges on its own; the owner releases batches later.
    if (outcome.state === 'review' && project.integration_branch && !outcome.flags.length) {
      try {
        approve(item.id, paths.root);
        outcome = { ...outcome, state: 'merged' };
        opts.log?.(`${item.id} merged into ${project.integration_branch}`);
      } catch (err) {
        outcome = { ...outcome, state: 'blocked', reason: (err as Error).message };
      }
    }
    outcomes.push(outcome);
    if (project.opt_ins?.notifications === 'desktop') {
      notify(`asf: ${item.id} ${outcome.state}`, outcome.reason ?? item.title);
    }
    if (opts.item || !opts.all || outcome.state === 'blocked') break;
  }
  return outcomes;
}
