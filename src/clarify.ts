import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BacklogItem } from './backlog.js';
import { runtimeFor, validate, vendorSchema } from './config.js';
import type { EngineContext } from './engine.js';
import { clarifyPrompt, systemPrompt } from './prompt.js';
import { appendEvent, saveTranscript } from './runlog.js';

export interface Question {
  id: string;
  question: string;
  why: string;
  options: string[];
  recommendation: string;
  /** A blocking question must be answered by the owner before the item can be built. */
  blocking: boolean;
}

/** What the analyst returns. */
export interface Analysis {
  understood: string;
  questions: Question[];
  assumptions: string[];
}

export interface Clarification extends Analysis {
  item: string;
  at: string;
  answers: Record<string, { answer: string; at: string; recommended?: boolean }>;
}

export const clarifyFile = (factory: string, id: string) => join(factory, 'clarify', `${id}.json`);

export function loadClarification(factory: string, id: string): Clarification | undefined {
  const file = clarifyFile(factory, id);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Clarification) : undefined;
}

export function saveClarification(factory: string, c: Clarification): void {
  const file = clarifyFile(factory, c.item);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
}

/** Blocking questions the owner has not answered yet. */
export const openQuestions = (c: Clarification) => c.questions.filter((q) => q.blocking && !c.answers[q.id]);

/**
 * The section added to the item once it is clear: every question with its answer (or the recommendation the analyst
 * would follow, for one that did not block), and the analyst's assumptions. Tester, builder and verifier read it as
 * part of the item.
 */
export function decisionsSection(c: Clarification): string {
  const lines = ['## Decisions', ''];
  for (const q of c.questions) {
    const a = c.answers[q.id];
    const answer = a ? a.answer : `${q.recommendation} (assumed, not asked)`;
    lines.push(`- ${q.question} ${answer}`);
  }
  for (const a of c.assumptions) lines.push(`- Assumed: ${a}`);
  return lines.join('\n');
}

/**
 * Runs the analyst on one item, read-only in the product root. Unique question ids are part of the contract: the
 * owner answers by id.
 */
export async function analyze(ctx: EngineContext, item: BacklogItem, previous?: Clarification): Promise<Clarification> {
  const { paths, project, policy } = ctx;
  const runtimeName = runtimeFor(project, 'analyst');
  const result = await ctx.runtime(runtimeName).call({
    cwd: paths.root,
    systemPrompt: systemPrompt('analyst', ['clarify-requirement']),
    prompt: clarifyPrompt({ root: paths.root, project, item, previous: previous && { questions: previous.questions, answers: previous.answers } }),
    access: 'read',
    model: project.models?.analyst,
    schema: vendorSchema('analysis'),
    allowedCommands: [],
    deniedCommands: policy.denied_commands,
    protectedPaths: policy.protected_paths,
    sandbox: policy.sandbox,
  });
  if (result.transcript) saveTranscript(paths.runs, item.id, `clarify-${Date.now()}`, result.transcript);
  const errors = result.ok ? validate('analysis', result.structured) : [result.error ?? 'failed'];
  const a = result.structured as Analysis | undefined;
  const ids = a?.questions?.map((q) => q.id) ?? [];
  if (!errors.length && new Set(ids).size !== ids.length) errors.push('question ids are not unique');
  appendEvent(paths.runs, {
    at: new Date().toISOString(),
    item: item.id,
    step: 'clarify',
    kind: 'agent',
    role: 'analyst',
    runtime: runtimeName,
    model: project.models?.analyst,
    tokens: result.tokens,
    cost_usd: result.costUsd,
    duration_ms: result.durationMs,
    outcome: errors.length ? 'error' : `${a!.questions.filter((q) => q.blocking).length} blocking`,
    detail: errors.length ? errors.join('; ') : undefined,
    denied: result.denied,
  });
  if (errors.length) throw new Error(`the analyst failed on ${item.id}: ${errors.join('; ')}`);
  // Answered questions stay; new ones never take an id the owner has already answered.
  const kept = previous ? previous.questions.filter((q) => previous.answers[q.id]) : [];
  const used = new Set(kept.map((q) => q.id));
  let n = kept.length;
  const fresh = a!.questions.map((q) => {
    if (!used.has(q.id)) return used.add(q.id), q;
    while (used.has(`Q${++n}`));
    used.add(`Q${n}`);
    return { ...q, id: `Q${n}` };
  });
  const answers = Object.fromEntries(kept.map((q) => [q.id, previous!.answers[q.id]!]));
  return { item: item.id, at: new Date().toISOString(), understood: a!.understood, questions: [...kept, ...fresh], assumptions: a!.assumptions, answers };
}
