import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadBacklog, type BacklogItem } from '../backlog.js';
import { loadClarification, type Clarification } from '../clarify.js';
import type { TrackedState } from '../config.js';
import { commitFiles, currentBranch, isClean } from '../git.js';
import { appendEvent } from '../runlog.js';
import { loadState } from '../state.js';
import { jira } from '../tracker/jira.js';
import type { Tracker } from '../tracker/types.js';
import { answer } from './clarify.js';
import { openProduct, UsageError, type Product } from './context.js';
import { approve, reject, retry } from './review.js';

/** Marks the factory's own comments. acli signs in as the owner, so the author alone cannot tell them apart. */
export const MARK = '[asf]';
const NEEDS_PO = 'needs-po';

interface Link {
  key: string;
  /** Comment ids already read, or there before the factory asked. */
  seen: string[];
  /** The clarification time the questions were posted for. */
  asked?: string;
  /** The last state the ticket was told about. */
  shown?: string;
}

interface TrackerState {
  items: Record<string, Link>;
}

const stateFile = (p: Product) => join(p.paths.factory, 'tracker.json');
const loadLinks = (p: Product): TrackerState => (existsSync(stateFile(p)) ? (JSON.parse(readFileSync(stateFile(p), 'utf8')) as TrackerState) : { items: {} });

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'item';

export function questionsComment(item: BacklogItem, c: Clarification): string {
  const lines = [`${MARK} Questions about ${item.id} before it is built`, '', `Understood: ${c.understood}`, ''];
  for (const q of c.questions.filter((x) => !c.answers[x.id])) {
    lines.push(`${q.id}${q.blocking ? ' (blocking)' : ''}: ${q.question}`);
    if (q.options.length) lines.push(`  Options: ${q.options.join(' / ')}`);
    lines.push(`  Recommended: ${q.recommendation} (${q.why})`, '');
  }
  if (c.assumptions.length) lines.push('Assumptions:', ...c.assumptions.map((a) => `- ${a}`), '');
  lines.push('Reply in a comment, one line per answer: "Q1: your answer". "/accept" takes the recommendation for every question left.');
  return lines.join('\n');
}

/** The owner's answers in one comment: `Q1: ...` lines (an answer runs on until the next one), or `/accept`. */
export function parseAnswers(body: string): { accept: boolean; answers: Record<string, string> } {
  const answers: Record<string, string> = {};
  let current: string | undefined;
  let accept = false;
  for (const line of body.split('\n')) {
    const m = /^\s*(Q\d+)\s*[:.)]\s*(.*)$/i.exec(line);
    if (m) {
      current = m[1]!.toUpperCase();
      answers[current] = m[2]!.trim();
    } else if (/^\s*\/accept\b/i.test(line)) {
      accept = true;
      current = undefined;
    } else if (current && line.trim()) {
      answers[current] += `\n${line.trim()}`;
    }
  }
  return { accept, answers };
}

/** A decision in an owner comment: `/approve`, `/reject <reason>` or `/retry`. */
export function parseDecision(body: string): { kind: 'approve' | 'reject' | 'retry'; reason?: string } | undefined {
  const m = /^\s*\/(approve|reject|retry)\b(.*)$/im.exec(body);
  if (!m) return undefined;
  const after = body.slice(body.indexOf(m[0]) + m[0].length);
  const reason = `${m[2] ?? ''}${after}`.trim();
  return { kind: m[1]!.toLowerCase() as 'approve' | 'reject' | 'retry', reason: reason || undefined };
}

export interface SyncOptions {
  root?: string;
  /** For tests; otherwise built from project.yaml. */
  tracker?: Tracker;
  log?: (msg: string) => void;
}

/**
 * Brings the tracker and the product together, without calling any model: new tickets become items, questions and
 * results are posted, and the owner's answers and decisions are applied. Run it before and after `asf clarify` and
 * `asf run`; `asf serve` does.
 */
export async function sync(opts: SyncOptions = {}): Promise<string[]> {
  const product = openProduct(opts.root);
  const { paths, project } = product;
  const cfg = project.tracker;
  if (!cfg && !opts.tracker) throw new UsageError('no tracker in .factory/project.yaml; the backlog/ folder is the tracker');
  const tracker = opts.tracker ?? jira(cfg!);
  const log: string[] = [];
  const say = (m: string) => (log.push(m), opts.log?.(m));
  const links = loadLinks(product);
  const save = () => writeFileSync(stateFile(product), JSON.stringify(links, null, 2) + '\n');
  const move = async (key: string, to: TrackedState) => {
    const status = cfg?.statuses?.[to];
    if (!status) return;
    try {
      await tracker.transition(key, status);
    } catch (err) {
      say(`${key}: could not move it to ${status}: ${(err as Error).message}`);
    }
  };
  const event = (item: string, outcome: string, detail?: string) =>
    appendEvent(paths.runs, { at: new Date().toISOString(), item, step: 'sync', kind: 'item', outcome, detail });
  const owner = cfg?.owner;
  /** New comments by the owner, not the factory's own; each is read once. */
  const fresh = async (link: Link) => {
    const all = await tracker.comments(link.key);
    const out = all.filter((c) => !link.seen.includes(c.id) && (!owner || c.author === owner) && !c.body.trimStart().startsWith(MARK));
    link.seen.push(...all.map((c) => c.id).filter((id) => !link.seen.includes(id)));
    return out;
  };
  const base = project.base_branch ?? 'main';
  const canCommit = () => currentBranch(paths.root) === base && isClean(paths.root);

  // 1. Intake: the owner's new tickets become new items.
  const tickets = await tracker.intake();
  let { items } = loadBacklog(paths.backlog);
  const linked = new Set(items.map((i) => i.tracker).filter(Boolean));
  for (const t of tickets.filter((x) => !linked.has(x.key))) {
    if (!canCommit()) {
      say(`${t.key}: not taken in; check out ${base} with a clean tree`);
      continue;
    }
    const n = Math.max(0, ...items.map((i) => Number(i.id.slice(2)))) + 1;
    const id = `B-${String(n).padStart(4, '0')}`;
    const file = join(paths.backlog, `${String(n).padStart(4, '0')}-${slug(t.title)}.md`);
    const title = t.title.replace(/\n/g, ' ').trim() || t.key;
    writeFileSync(file, `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\nstatus: new\ntracker: ${t.key}\n---\n${t.body.trim()}\n\nSource: ${t.key}\n`);
    commitFiles(paths.root, [file], `chore(backlog): ${id} from ${t.key}\n`);
    links.items[id] = { key: t.key, seen: (await tracker.comments(t.key)).map((c) => c.id) };
    save();
    await move(t.key, 'clarifying');
    event(id, 'taken in', t.key);
    say(`${t.key} → ${id} (${relative(paths.root, file)})`);
    items = loadBacklog(paths.backlog).items;
  }

  const state = loadState(paths.state);
  for (const item of items.filter((i) => i.tracker)) {
    const link = (links.items[item.id] ??= { key: item.tracker!, seen: [] });

    // 2. Questions out, answers in.
    if (item.status === 'new') {
      const c = loadClarification(paths.factory, item.id);
      if (c && link.asked !== c.at && c.questions.some((q) => !c.answers[q.id])) {
        await fresh(link);
        await tracker.comment(link.key, questionsComment(item, c));
        await tracker.label(link.key, [NEEDS_PO], []);
        link.asked = c.at;
        save();
        say(`${link.key}: asked ${c.questions.filter((q) => !c.answers[q.id]).length} question(s)`);
        continue;
      }
      if (c && link.asked) {
        for (const cm of await fresh(link)) {
          const { accept, answers } = parseAnswers(cm.body);
          try {
            let out;
            for (const [q, a] of Object.entries(answers)) out = answer(item.id, q, a, { root: paths.root });
            if (accept) out = answer(item.id, undefined, '', { accept: true, root: paths.root });
            if (out?.ready) {
              await tracker.comment(link.key, `${MARK} ${item.id} is clear to build. The decisions are in ${relative(paths.root, item.file)}.`);
              await tracker.label(link.key, [], [NEEDS_PO]);
              await move(link.key, 'ready');
              link.shown = 'ready';
              say(`${link.key}: answered; ${item.id} is ready`);
            } else if (out?.note) {
              say(`${link.key}: answered, not made ready: ${out.note}`);
            } else if (out) {
              say(`${link.key}: answered; ${out.open} blocking question(s) left`);
            }
          } catch (err) {
            await tracker.comment(link.key, `${MARK} Could not use that answer: ${(err as Error).message}`);
          }
        }
        save();
      }
      continue;
    }

    // 3. Where the work is, and the owner's decisions on it.
    const st = state.items[item.id];
    const now = item.status === 'done' ? 'done' : st?.state === 'review' ? 'review' : st?.state === 'blocked' ? 'blocked' : st ? 'in_progress' : undefined;
    if (now && now !== link.shown) {
      await fresh(link);
      if (now === 'review') {
        const flags = st?.flags?.length ? `\nIt touches paths that need your attention: ${st.flags.join(', ')}.` : '';
        await tracker.comment(link.key, `${MARK} ${item.id} is built and passed its checks and review, on branch ${st!.branch}.${flags}\n\n${st!.summary ?? ''}\n\nReply "/approve" to merge it, or "/reject <reason>" to send it back.`);
      } else if (now === 'blocked') {
        await tracker.comment(link.key, `${MARK} ${item.id} is blocked: ${st!.reason ?? 'unknown'}\n\nReply "/retry" to let it run again.`);
      } else if (now === 'done') {
        await tracker.comment(link.key, `${MARK} ${item.id} is merged.`);
      }
      await move(link.key, now);
      link.shown = now;
      save();
      say(`${link.key}: ${now}`);
      continue;
    }
    if (now === 'review' || now === 'blocked') {
      for (const cm of await fresh(link)) {
        const d = parseDecision(cm.body);
        if (!d) continue;
        try {
          if (d.kind === 'approve' && now === 'review') {
            approve(item.id, paths.root);
            await tracker.comment(link.key, `${MARK} ${item.id} is merged.`);
            await move(link.key, 'done');
            link.shown = 'done';
          } else if (d.kind === 'reject' && now === 'review') {
            reject(item.id, d.reason ?? '', paths.root);
            await move(link.key, 'in_progress');
            link.shown = 'in_progress';
          } else if (d.kind === 'retry' && now === 'blocked') {
            retry(item.id, paths.root);
            await move(link.key, 'in_progress');
            link.shown = 'in_progress';
          } else {
            continue;
          }
          event(item.id, d.kind, link.key);
          say(`${link.key}: ${d.kind}`);
          break;
        } catch (err) {
          await tracker.comment(link.key, `${MARK} Could not ${d.kind} ${item.id}: ${(err as Error).message}`);
        }
      }
      save();
    }
  }
  save();
  return log;
}
