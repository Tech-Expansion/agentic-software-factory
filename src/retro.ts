import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBacklog, setStatus, type BacklogItem } from './backlog.js';
import { modelFor, runtimeFor, validate, vendorSchema } from './config.js';
import type { Product } from './commands/context.js';
import { UsageError } from './commands/context.js';
import type { EngineContext, ItemOutcome } from './engine.js';
import { commitFiles, currentBranch, isClean } from './git.js';
import { factoryHome, repoPath } from './paths.js';
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
  /** Who decided it: the tech lead after the retro, or the owner, who can reverse the tech lead. */
  decided_by?: 'tech-lead' | 'owner';
  decided_at?: string;
  reason?: string;
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
  const runtimeName = runtimeFor(project, 'scrum-master');
  const worktree = join(paths.worktrees, item.id);
  const result = await ctx.runtime(runtimeName).call({
    cwd: existsSync(worktree) ? worktree : paths.root,
    systemPrompt: systemPrompt('scrum-master', ['run-retro'], paths.factory),
    prompt: retroPrompt(item, outcome, failed, lessons),
    access: 'read',
    model: modelFor(project, 'scrum-master'),
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
    role: 'scrum-master',
    runtime: runtimeName,
    model: modelFor(project, 'scrum-master'),
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

/** The tech lead decides the lessons a retro proposed. One that is not decided, or fails to apply, stays for the owner. */
export async function decideLessons(ctx: EngineContext, item: BacklogItem, proposed: Lesson[]): Promise<Lesson[]> {
  const { paths, project, policy } = ctx;
  const open = proposed.filter((l) => l.status === 'proposed');
  if (!open.length) return [];
  const runtimeName = runtimeFor(project, 'tech-lead');
  const worktree = join(paths.worktrees, item.id);
  const failed = failures(readEvents(paths.runs), item.id);
  const prompt = [
    `## Item ${item.id}: ${item.title}`,
    `## What went wrong\n\n${failed.slice(-6).map((e) => `- ${cut(e.detail, 800)}`).join('\n') || '- (see the lessons)'}`,
    `## Proposed lessons\n\n${open.map((l) => `### ${l.id}: ${l.title}\n\nKind: ${l.scope} ${l.kind}${l.note ? ` (${l.note})` : ''}\n\nProblem: ${l.problem}\n\nProposal: ${l.proposal}`).join('\n\n')}`,
  ].join('\n\n');
  const result = await ctx.runtime(runtimeName).call({
    cwd: existsSync(worktree) ? worktree : paths.root,
    systemPrompt: systemPrompt('tech-lead', ['decide-lessons'], paths.factory),
    prompt,
    access: 'read',
    model: modelFor(project, 'tech-lead'),
    schema: vendorSchema('lesson-decisions'),
    allowedCommands: [],
    deniedCommands: policy.denied_commands,
    protectedPaths: policy.protected_paths,
    sandbox: policy.sandbox,
  });
  const errors = result.ok ? validate('lesson-decisions', result.structured) : [result.error ?? 'failed'];
  appendEvent(paths.runs, {
    at: new Date().toISOString(),
    item: item.id,
    step: 'lessons',
    kind: 'agent',
    role: 'tech-lead',
    runtime: runtimeName,
    model: modelFor(project, 'tech-lead'),
    tokens: result.tokens,
    duration_ms: result.durationMs,
    outcome: errors.length ? 'error' : 'decided',
    detail: errors.length ? errors.join('; ') : undefined,
  });
  if (errors.length) throw new Error(`the tech lead could not decide the lessons from ${item.id}: ${errors.join('; ')}`);
  const out: Lesson[] = [];
  for (const d of (result.structured as { decisions: { id: string; decision: 'accept' | 'reject'; reason: string }[] }).decisions) {
    if (!open.some((l) => l.id === d.id)) continue;
    try {
      out.push(decideLesson(ctx, d.id, d.decision, { by: 'tech-lead', reason: d.reason }));
    } catch (err) {
      ctx.log?.(`${d.id} left for you: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * A decision on a lesson: the tech lead's on a proposed one, or the owner's, who may also reverse one already made.
 * Accepting one never changes the policy: a check becomes a backlog item the team builds like any other, a doc becomes
 * a line in the project memory, and a factory lesson becomes a proposal for the factory's own repository, to be
 * measured with `asf eval` before it is adopted. Reversing an accepted one parks its backlog item, takes its line out
 * of the memory, or deletes its proposal.
 */
export function decideLesson(product: Product, id: string, decision: 'accept' | 'reject', who: { by: 'tech-lead' | 'owner'; reason?: string } = { by: 'owner' }): Lesson {
  const { paths, project } = product;
  const lessons = loadLessons(paths.factory);
  const l = lessons.find((x) => x.id === id);
  if (!l) throw new UsageError(`no lesson ${id}`);
  const wanted = decision === 'accept' ? 'accepted' : 'rejected';
  if (l.status === wanted || (l.status !== 'proposed' && who.by !== 'owner')) throw new UsageError(`${id} is already ${l.status}`);
  const base = project.base_branch ?? 'main';
  const onBase = () => {
    if (currentBranch(paths.root) !== base || !isClean(paths.root)) throw new UsageError(`check out ${base} with a clean tree first; deciding ${id} commits to it`);
  };
  const decided = () => {
    Object.assign(l, { decided_by: who.by, decided_at: new Date().toISOString(), reason: who.reason });
    saveLessons(paths.factory, lessons);
    appendEvent(paths.runs, { at: new Date().toISOString(), item: l.items[0]!, step: 'lesson', kind: 'item', outcome: l.status, detail: `${l.id} by the ${who.by === 'owner' ? 'owner' : 'tech lead'}${l.applied ? ` → ${l.applied}` : ''}` });
    return l;
  };
  if (decision === 'reject') {
    if (l.status === 'accepted' && l.applied) {
      if (l.scope === 'factory') rmSync(l.applied, { force: true });
      else if (l.kind === 'doc') {
        onBase();
        const memory = join(paths.memory, 'context.md');
        const text = existsSync(memory) ? readFileSync(memory, 'utf8') : '';
        writeFileSync(memory, text.split('\n').filter((line) => !line.endsWith(`(${l.id})`)).join('\n'));
        commitFiles(paths.root, [memory], `docs(memory): drop ${l.id} ${l.title}\n`);
      } else {
        const it = loadBacklog(paths.backlog).items.find((i) => i.id === l.applied);
        if (it && it.status !== 'done') {
          onBase();
          setStatus(it.file, 'draft');
          commitFiles(paths.root, [it.file], `chore(backlog): park ${it.id}, lesson ${l.id} was rejected\n`);
        }
      }
    }
    l.status = 'rejected';
    return decided();
  }
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
    onBase();
    if (l.kind === 'doc') {
      const memory = join(paths.memory, 'context.md');
      mkdirSync(paths.memory, { recursive: true });
      const text = existsSync(memory) ? readFileSync(memory, 'utf8') : '';
      appendFileSync(memory, `${text && !text.endsWith('\n') ? '\n' : ''}${/^## Lessons$/m.test(text) ? '' : '\n## Lessons\n\n'}- ${l.title}. ${l.proposal} (${l.id})\n`);
      commitFiles(paths.root, [memory], `docs(memory): ${l.id} ${l.title}\n`);
      l.applied = repoPath(paths.root, memory);
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
  return decided();
}
