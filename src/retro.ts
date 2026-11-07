import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadBacklog, type BacklogItem } from './backlog.js';
import { runtimeFor, validate, vendorSchema } from './config.js';
import type { Product } from './commands/context.js';
import { UsageError } from './commands/context.js';
import type { EngineContext, ItemOutcome } from './engine.js';
import { commitFiles, currentBranch, isClean } from './git.js';
import { factoryHome } from './paths.js';
import { systemPrompt } from './prompt.js';
import { appendEvent, readEvents, saveTranscript, type RunEvent } from './runlog.js';

export interface Proposed {
  title: string;
  problem: string;
  kind: 'check' | 'doc' | 'skill' | 'workflow';
  scope: 'product' | 'factory';
  proposal: string;
  recurs: string;
}

export interface Lesson extends Omit<Proposed, 'recurs'> {
  id: string;
  /** Items it was seen on; more than one means the mistake repeats. */
  items: string[];
  at: string;
  status: 'proposed' | 'accepted' | 'rejected';
  /** What accepting it made: a backlog item, a line in the memory, a proposal file for the factory. */
  applied?: string;
  note?: string;
}

const file = (factory: string) => join(factory, 'lessons.json');
export const loadLessons = (factory: string): Lesson[] => (existsSync(file(factory)) ? (JSON.parse(readFileSync(file(factory), 'utf8')) as Lesson[]) : []);
const saveLessons = (factory: string, l: Lesson[]) => writeFileSync(file(factory), JSON.stringify(l, null, 2) + '\n');

/** What an item went through since its last retro: failed attempts and the owner's rejections. */
export function failures(events: RunEvent[], id: string): RunEvent[] {
  const mine = events.filter((e) => e.item === id);
  const last = mine.map((e) => e.step).lastIndexOf('retro');
  return mine.slice(last + 1).filter((e) => (e.step === 'attempt' && e.outcome === 'failed') || e.step === 'reject');
}

const cut = (s: string | undefined, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n)}\n[cut]` : s);

export function retroPrompt(item: BacklogItem, outcome: ItemOutcome, failed: RunEvent[], lessons: Lesson[]): string {
  const out = [`## Item ${item.id}: ${item.title}\n\n${cut(item.body, 6000) || '(no notes)'}`];
  out.push(`## How it ended\n\n${outcome.state}${outcome.reason ? `: ${cut(outcome.reason, 1500)}` : ''}`);
  out.push(
    `## What went wrong, in order\n\n${failed
      .slice(-6)
      .map((e) => (e.step === 'reject' ? `- The owner rejected it: ${cut(e.detail, 1500)}` : `- Attempt ${e.attempt}: ${cut(e.detail, 1500)}`))
      .join('\n')}`,
  );
  const known = lessons.map((l) => `- ${l.id} [${l.scope} ${l.kind}, ${l.status}${l.items.length > 1 ? `, seen ${l.items.length} times` : ''}] ${l.title}`);
  out.push(`## Existing lessons\n\n${known.join('\n') || '- none'}`);
  return out.join('\n\n');
}

/**
 * The retrospective after an item that needed more than one attempt or was rejected. It only proposes: the owner
 * accepts or rejects each lesson. A mistake that repeats an accepted doc lesson comes back as a check, because the
 * doc did not stop it.
 */
export async function retro(ctx: EngineContext, item: BacklogItem, outcome: ItemOutcome): Promise<Lesson[]> {
  const { paths, project, policy } = ctx;
  if (outcome.state === 'paused' || outcome.state === 'plan-review') return [];
  const failed = failures(readEvents(paths.runs), item.id);
  if (!failed.length) return [];
  const lessons = loadLessons(paths.factory);
  const runtimeName = runtimeFor(project, 'retro');
  const worktree = join(paths.worktrees, item.id);
  const result = await ctx.runtime(runtimeName).call({
    cwd: existsSync(worktree) ? worktree : paths.root,
    systemPrompt: systemPrompt('retro', ['run-retro']),
    prompt: retroPrompt(item, outcome, failed, lessons),
    access: 'read',
    model: project.models?.retro,
    schema: vendorSchema('lessons'),
    allowedCommands: [],
    deniedCommands: policy.denied_commands,
    protectedPaths: policy.protected_paths,
    sandbox: policy.sandbox,
  });
  if (result.transcript) saveTranscript(paths.runs, item.id, `retro-${Date.now()}`, result.transcript);
  const errors = result.ok ? validate('lessons', result.structured) : [result.error ?? 'failed'];
  const proposed = errors.length ? [] : (result.structured as { lessons: Proposed[] }).lessons;
  appendEvent(paths.runs, {
    at: new Date().toISOString(),
    item: item.id,
    step: 'retro',
    kind: 'agent',
    role: 'retro',
    runtime: runtimeName,
    model: project.models?.retro,
    tokens: result.tokens,
    duration_ms: result.durationMs,
    outcome: errors.length ? 'error' : `${proposed.length} lesson(s)`,
    detail: errors.length ? errors.join('; ') : undefined,
  });
  if (errors.length) throw new Error(`the retro failed on ${item.id}: ${errors.join('; ')}`);

  const touched: Lesson[] = [];
  const now = new Date().toISOString();
  for (const p of proposed) {
    const known = p.recurs ? lessons.find((l) => l.id === p.recurs) : undefined;
    if (known) {
      if (!known.items.includes(item.id)) known.items.push(item.id);
      if (known.status === 'accepted' && known.kind === 'doc') {
        Object.assign(known, { status: 'proposed', kind: 'check', note: `came back on ${item.id} after it was written down; a check stops it` });
      } else if (known.status === 'rejected') {
        Object.assign(known, { status: 'proposed', note: `came back on ${item.id} after it was rejected` });
      }
      touched.push(known);
      continue;
    }
    const { recurs: _, ...rest } = p;
    const lesson: Lesson = { ...rest, id: `L-${lessons.length + 1}`, items: [item.id], at: now, status: 'proposed' };
    lessons.push(lesson);
    touched.push(lesson);
  }
  saveLessons(paths.factory, lessons);
  return touched;
}

/**
 * The owner's decision on a lesson. Accepting one never changes the policy: a check becomes a backlog item the team
 * builds like any other, a doc becomes a line in the project memory, and a factory lesson becomes a proposal for the
 * factory's own repository, to be measured with `asf eval` before it is adopted.
 */
export function decideLesson(product: Product, id: string, decision: 'accept' | 'reject'): Lesson {
  const { paths, project } = product;
  const lessons = loadLessons(paths.factory);
  const l = lessons.find((x) => x.id === id);
  if (!l) throw new UsageError(`no lesson ${id}`);
  if (l.status !== 'proposed') throw new UsageError(`${id} is already ${l.status}`);
  if (decision === 'reject') {
    l.status = 'rejected';
    saveLessons(paths.factory, lessons);
    return l;
  }
  const base = project.base_branch ?? 'main';
  if (l.scope === 'factory') {
    const dir = join(factoryHome(), 'proposals');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${project.name}-${l.id}.md`);
    writeFileSync(
      out,
      `# ${l.title}\n\nFrom ${project.name}, items ${l.items.join(', ')}. Kind: ${l.kind}.\n\n## Problem\n\n${l.problem}\n\n## Proposal\n\n${l.proposal}\n\nAdopt it only with \`asf eval --trials 3\` numbers before and after.\n`,
    );
    l.applied = out;
  } else {
    if (currentBranch(paths.root) !== base || !isClean(paths.root)) throw new UsageError(`check out ${base} with a clean tree first; accepting ${id} commits to it`);
    if (l.kind === 'doc') {
      const memory = join(paths.memory, 'context.md');
      mkdirSync(paths.memory, { recursive: true });
      const text = existsSync(memory) ? readFileSync(memory, 'utf8') : '';
      appendFileSync(memory, `${text && !text.endsWith('\n') ? '\n' : ''}${/^## Lessons$/m.test(text) ? '' : '\n## Lessons\n\n'}- ${l.title}. ${l.proposal} (${l.id})\n`);
      commitFiles(paths.root, [memory], `docs(memory): ${l.id} ${l.title}\n`);
      l.applied = relative(paths.root, memory);
    } else {
      const { items } = loadBacklog(paths.backlog);
      const n = Math.max(0, ...items.map((i) => Number(i.id.slice(2)))) + 1;
      const itemId = `B-${String(n).padStart(4, '0')}`;
      const out = join(paths.backlog, `${String(n).padStart(4, '0')}-lesson-${l.id.toLowerCase()}.md`);
      writeFileSync(
        out,
        `---\nid: ${itemId}\ntitle: ${JSON.stringify(`Check: ${l.title}`)}\nstatus: ready\npriority: 1\n---\n${l.problem}\n\n${l.proposal}\n\nMake this a check the existing commands run (a test or a lint rule), so the mistake fails the build instead of reaching review. Source: lesson ${l.id}, items ${l.items.join(', ')}.\n`,
      );
      commitFiles(paths.root, [out], `chore(backlog): ${itemId} from lesson ${l.id}\n`);
      l.applied = itemId;
    }
  }
  l.status = 'accepted';
  saveLessons(paths.factory, lessons);
  appendEvent(paths.runs, { at: new Date().toISOString(), item: l.items[0]!, step: 'lesson', kind: 'item', outcome: 'accepted', detail: `${l.id} → ${l.applied}` });
  return l;
}
