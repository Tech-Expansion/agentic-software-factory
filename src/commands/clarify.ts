import { appendFileSync, readFileSync } from 'node:fs';
import { loadBacklog, setStatus, type BacklogItem } from '../backlog.js';
import { analyze, decisionsSection, loadClarification, openQuestions, saveClarification, type Clarification } from '../clarify.js';
import type { EngineContext } from '../engine.js';
import { commitFiles, currentBranch, isClean } from '../git.js';
import { openProduct, runtimes, UsageError, type Product } from './context.js';

export interface ClarifyOutcome {
  id: string;
  open: number;
  ready: boolean;
  /** Why a clear item was not made ready. */
  note?: string;
}

function findItem(product: Product, id: string): BacklogItem {
  const { items, errors } = loadBacklog(product.paths.backlog);
  if (errors.length) throw new UsageError(`fix the backlog first:\n  ${errors.join('\n  ')}`);
  const item = items.find((i) => i.id === id);
  if (!item) throw new UsageError(`no backlog item ${id}`);
  return item;
}

/**
 * Once no blocking question is open, the decisions go into the item and it becomes ready, in one commit on the base
 * branch that holds only the item file.
 */
function makeReady(product: Product, item: BacklogItem, c: Clarification): ClarifyOutcome {
  const { root } = product.paths;
  const base = product.project.base_branch ?? 'main';
  const out = { id: item.id, open: 0, ready: false };
  if (currentBranch(root) !== base) return { ...out, note: `check out ${base} and run \`asf answer ${item.id} --accept\` to make it ready` };
  if (!isClean(root)) return { ...out, note: `commit or stash your changes, then run \`asf answer ${item.id} --accept\` to make it ready` };
  const text = readFileSync(item.file, 'utf8');
  appendFileSync(item.file, `${text.endsWith('\n') ? '' : '\n'}\n${decisionsSection(c)}\n`);
  setStatus(item.file, 'ready');
  commitFiles(root, [item.file], `chore(backlog): ${item.id} is clear to build\n\nClarified with the owner: ${Object.keys(c.answers).length} answer(s).\n`);
  return { ...out, ready: true };
}

export interface ClarifyOptions {
  item?: string;
  /** Ask again about an item that has questions already, keeping the answers. */
  again?: boolean;
  root?: string;
  log?: (msg: string) => void;
  /** For tests. */
  context?: Partial<EngineContext>;
}

/** Runs the analyst on new items (or one), and makes each ready that has nothing blocking left. */
export async function clarify(opts: ClarifyOptions = {}): Promise<ClarifyOutcome[]> {
  const product = openProduct(opts.root);
  const log = opts.log ?? (() => {});
  const ctx: EngineContext = { ...product, runtime: (n) => runtimes[n], ...opts.context };
  const { items, errors } = loadBacklog(product.paths.backlog);
  if (errors.length) throw new UsageError(`fix the backlog first:\n  ${errors.join('\n  ')}`);
  const todo = opts.item ? [findItem(product, opts.item)] : items.filter((i) => i.status === 'new');
  const outcomes: ClarifyOutcome[] = [];
  for (const item of todo) {
    if (item.status !== 'new') throw new UsageError(`${item.id} is ${item.status}; only new items are clarified`);
    const previous = loadClarification(product.paths.factory, item.id);
    if (previous && !opts.again) {
      outcomes.push({ id: item.id, open: openQuestions(previous).length, ready: false, note: 'already asked; answer with `asf answer`, or use --again' });
      continue;
    }
    log(`${item.id}: asking the analyst`);
    const c = await analyze(ctx, item, previous);
    saveClarification(product.paths.factory, c);
    const open = openQuestions(c).length;
    outcomes.push(open ? { id: item.id, open, ready: false } : makeReady(product, item, c));
  }
  return outcomes;
}

/** Records the owner's answer to one question, or (with `accept`) takes the recommendation for every one left. */
export function answer(id: string, question: string | undefined, text: string, opts: { accept?: boolean; root?: string } = {}): ClarifyOutcome {
  const product = openProduct(opts.root);
  const item = findItem(product, id);
  if (item.status !== 'new') throw new UsageError(`${id} is ${item.status}, not waiting for answers`);
  const c = loadClarification(product.paths.factory, id);
  if (!c) throw new UsageError(`${id} has no questions yet; run \`asf clarify --item ${id}\``);
  const at = new Date().toISOString();
  if (opts.accept) {
    for (const q of c.questions) if (!c.answers[q.id]) c.answers[q.id] = { answer: q.recommendation, at, recommended: true };
  } else {
    const q = c.questions.find((x) => x.id === question);
    if (!q) throw new UsageError(`${id} has no question ${question}; questions: ${c.questions.map((x) => x.id).join(', ')}`);
    if (!text.trim()) throw new UsageError('give an answer');
    c.answers[q.id] = { answer: text.trim(), at };
  }
  saveClarification(product.paths.factory, c);
  const open = openQuestions(c).length;
  return open ? { id, open, ready: false } : makeReady(product, item, c);
}

/** Every open question, with its options and the team's recommendation. */
export function questions(root?: string): string {
  const product = openProduct(root);
  const { items } = loadBacklog(product.paths.backlog);
  const out: string[] = [];
  for (const item of items.filter((i) => i.status === 'new')) {
    const c = loadClarification(product.paths.factory, item.id);
    if (!c) {
      out.push(`${item.id} ${item.title}: not analysed yet (asf clarify)`, '');
      continue;
    }
    const left = c.questions.filter((q) => !c.answers[q.id]);
    out.push(`${item.id} ${item.title}: ${openQuestions(c).length} blocking question(s) open`, `  understood: ${c.understood}`);
    for (const q of left) {
      out.push(`  ${q.id}${q.blocking ? ' [blocking]' : ''} ${q.question}`);
      if (q.options.length) out.push(...q.options.map((o) => `      - ${o}`));
      out.push(`      recommended: ${q.recommendation} (${q.why})`);
    }
    if (c.assumptions.length) out.push('  assumptions:', ...c.assumptions.map((a) => `      - ${a}`));
    out.push('');
  }
  return out.length ? out.join('\n').trimEnd() : 'No open questions.';
}
