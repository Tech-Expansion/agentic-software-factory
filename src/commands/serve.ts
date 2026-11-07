import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadBacklog, nextReady, type BacklogItem } from '../backlog.js';
import { runItem, type EngineContext, type ItemOutcome } from '../engine.js';
import { currentBranch, git, isRepo } from '../git.js';
import { acquire } from '../lock.js';
import { notify } from '../notify.js';
import { appendEvent } from '../runlog.js';
import { loadState, saveState } from '../state.js';
import type { Tracker } from '../tracker/types.js';
import { clarify } from './clarify.js';
import { openProduct, runtimes, UsageError } from './context.js';
import { settle } from './run.js';
import { sync } from './sync.js';

export interface ServeOptions {
  root?: string;
  /** Items built at the same time, each in its own worktree. */
  workers?: number;
  /** Seconds between looks for work when there is none. */
  intervalSeconds?: number;
  /** Stop after this many rounds; for tests and `--once`. */
  rounds?: number;
  log?: (msg: string) => void;
  /** For tests. */
  context?: Partial<EngineContext>;
  tracker?: Tracker;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The team's day: take in tickets, ask what needs asking, build what is ready, a few items at a time, and report back.
 * Each round only wakes the roles that have work, so an idle team spends no tokens. A usage limit pauses the work
 * until the quota resets instead of failing items; a stop or a crash leaves items to be resumed.
 */
export async function serve(opts: ServeOptions = {}): Promise<{ rounds: number; outcomes: ItemOutcome[] }> {
  const product = openProduct(opts.root);
  const { paths, project } = product;
  if (!isRepo(paths.root)) throw new UsageError(`${paths.root} is not a git repository`);
  const base = project.base_branch ?? 'main';
  if (currentBranch(paths.root) !== base) throw new UsageError(`check out ${base} first; items branch from it`);
  const workers = Math.max(1, opts.workers ?? 1);
  const interval = (opts.intervalSeconds ?? 60) * 1000;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const ctx: EngineContext = { ...product, runtime: (n) => runtimes[n], log, ...opts.context };
  const tracked = !!(opts.tracker || project.tracker);

  const unlock = acquire(paths.factory, 'serve');
  try {
    recover(paths, log);
    const running = new Map<string, Promise<void>>();
    const outcomes: ItemOutcome[] = [];
    let pausedUntil = 0;
    let rounds = 0;

    const start = (item: BacklogItem) => {
      const p = runItem(ctx, item)
        .then((o) => settle(product, o, log))
        .then((o) => {
          outcomes.push(o);
          if (o.state === 'paused') pausedUntil = Math.max(pausedUntil, o.resumeAt ?? now() + 15 * 60_000);
          if (project.opt_ins?.notifications === 'desktop' && o.state !== 'merged') notify(`asf: ${o.id} ${o.state}`, o.reason ?? item.title);
        })
        .catch((err: Error) => log(`${item.id}: ${err.message}`))
        .finally(() => running.delete(item.id));
      running.set(item.id, p);
    };

    while (!opts.signal?.aborted && (opts.rounds === undefined || rounds < opts.rounds)) {
      rounds++;
      if (now() < pausedUntil) {
        log(`paused by a usage limit until ${new Date(pausedUntil).toISOString()}`);
        await Promise.race([sleep(Math.min(pausedUntil - now(), interval)), ...running.values()]);
        continue;
      }
      try {
        if (tracked) await sync({ root: paths.root, tracker: opts.tracker, log });
        const asked = await clarify({ root: paths.root, context: opts.context, log });
        if (tracked && asked.some((o) => !o.note)) await sync({ root: paths.root, tracker: opts.tracker, log });
      } catch (err) {
        log(`intake: ${(err as Error).message}`);
      }

      const { items, errors } = loadBacklog(paths.backlog);
      if (errors.length) log(`backlog errors, nothing new is started:\n  ${errors.join('\n  ')}`);
      while (!errors.length && running.size < workers && now() >= pausedUntil) {
        const state = loadState(paths.state);
        const next = nextReady(
          items.filter((i) => !running.has(i.id)),
          state,
        );
        if (!next) break;
        log(`${next.id} starting (${running.size + 1}/${workers})`);
        start(next);
      }
      // Wait for an item to finish or for the next look, whichever comes first.
      await Promise.race([sleep(interval), ...running.values()]);
      if (tracked && !running.size) {
        try {
          await sync({ root: paths.root, tracker: opts.tracker, log });
        } catch (err) {
          log(`sync: ${(err as Error).message}`);
        }
      }
    }
    await Promise.all(running.values());
    if (tracked) await sync({ root: paths.root, tracker: opts.tracker, log }).catch((err: Error) => log(`sync: ${err.message}`));
    return { rounds, outcomes };
  } finally {
    unlock();
  }
}

/** After a crash or a kill: items that were running resume from their worktrees, and a half-done merge is undone. */
function recover(paths: ReturnType<typeof openProduct>['paths'], log: (msg: string) => void): void {
  const state = loadState(paths.state);
  let changed = false;
  for (const [id, st] of Object.entries(state.items)) {
    if (st.state !== 'in-progress') continue;
    state.items[id] = { ...st, state: 'rework', reason: 'resumed after the factory stopped', updated_at: new Date().toISOString() };
    appendEvent(paths.runs, { at: new Date().toISOString(), item: id, step: 'serve', kind: 'item', outcome: 'resumed' });
    log(`${id} resumes where it stopped`);
    changed = true;
  }
  if (changed) saveState(paths.state, state);
  const wt = join(paths.worktrees, '_integration');
  if (existsSync(wt) && git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).trim()) {
    git(wt, ['merge', '--abort'], true);
    log('undid a merge into the integration branch that was cut off');
  }
}
