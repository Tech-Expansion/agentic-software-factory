import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factoryRoot } from './paths.js';
import type { BacklogItem } from './backlog.js';
import { canonicalRole, ROLE_ALIASES, type ProjectConfig } from './config.js';

const stripFront = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

function readPrompt(file: string): string | undefined {
  return existsSync(file) ? stripFront(readFileSync(file, 'utf8')) : undefined;
}

/**
 * The factory's text with the product's own added under "Product rules". A product adds to a role or skill and
 * never replaces it, so it cannot drop the factory's rules; it may also bring a role or skill of its own.
 */
function layered(kind: string, name: string, own: string, product: string[] = []): string {
  const base = readPrompt(own);
  const extra = product.map(readPrompt).filter((t): t is string => !!t).join('\n\n') || undefined;
  if (base === undefined && extra === undefined) throw new Error(`unknown ${kind}: ${name}`);
  if (!base) return extra!;
  return extra ? `${base}\n\n## Product rules\n\n${extra}` : base;
}

/** `local` is the product's .factory directory, where `agents/<name>.md` adds to the role. */
export function loadRole(role: string, local?: string): string {
  const name = canonicalRole(role);
  // A product's file under a role's old name still adds to it.
  const names = [name, ...Object.keys(ROLE_ALIASES).filter((k) => ROLE_ALIASES[k] === name)];
  return layered('role', name, join(factoryRoot, 'agents', `${name}.md`), local ? names.map((n) => join(local, 'agents', `${n}.md`)) : []);
}

/** `local` is the product's .factory directory, where `skills/<name>/SKILL.md` adds to the skill. */
export function loadSkill(name: string, local?: string): string {
  return layered('skill', name, join(factoryRoot, 'skills', name, 'SKILL.md'), local ? [join(local, 'skills', name, 'SKILL.md')] : []);
}

/**
 * Role first, then only the skills the step names. Nothing item-specific, so it stays cacheable across items.
 * `local` is the product's .factory directory, for the product's additions.
 */
export function systemPrompt(role: string, skills: string[], local?: string): string {
  const parts = [`# Your role\n\n${loadRole(role, local)}`];
  for (const s of skills) parts.push(`# Skill: ${s}\n\n${loadSkill(s, local)}`);
  return parts.join('\n\n');
}

export interface ItemContext {
  root: string;
  project: ProjectConfig;
  item: BacklogItem;
  attempt: number;
  maxAttempts: number;
  feedback?: string;
  checks?: string;
  diff?: string;
  /** Acceptance tests written before the build, which the builder cannot change. */
  lockedTests?: string[];
  /** The approved plan, for a high-risk item. */
  plan?: string;
}

/** Reads a file for a prompt, without HTML comments (template guidance costs tokens and tells the agent nothing). */
function readIfExists(file: string, max = 20_000): string | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text;
}

export function itemPrompt(c: ItemContext): string {
  const { project, item } = c;
  const out: string[] = [];
  out.push(`# Product: ${project.name} (stage: ${project.stage})`);
  if (project.hypothesis) out.push(`Hypothesis: ${project.hypothesis}`);
  const memory = readIfExists(join(c.root, '.factory', 'memory', 'context.md'));
  if (memory) out.push(`## Project memory\n\n${memory}`);
  out.push(`## Backlog item ${item.id}: ${item.title}\n\n${item.body || '(no notes)'}`);
  if (item.criteria?.length) out.push(`Acceptance criteria in scope: ${item.criteria.join(', ')}`);
  if (item.spec) {
    const spec = readIfExists(join(c.root, item.spec));
    out.push(spec ? `## Spec (${item.spec})\n\n${spec}` : `Spec ${item.spec} is missing.`);
  }
  const checks = project.commands.check.map((cmd) => `- \`${cmd}\``).join('\n');
  out.push(`## Checks the runner will run after you\n\n${checks}`);
  if (c.plan) out.push(`## The approved plan\n\nFollow it. A change outside it needs a new plan: stop, and say so in your final message.\n\n${c.plan}`);
  if (c.lockedTests?.length) {
    out.push(
      `## Acceptance tests (locked)\n\nWritten from the criteria before the build. You cannot change them: make them pass. If one is wrong, say so under "Assumptions" in your final message.\n\n${c.lockedTests.map((f) => `- ${f}`).join('\n')}`,
    );
  }
  out.push(`Attempt ${c.attempt} of ${c.maxAttempts}.`);
  if (c.feedback) out.push(`## Feedback from the previous attempt\n\n${c.feedback}`);
  if (c.checks) out.push(`## Check results\n\n${c.checks}`);
  if (c.diff) out.push(`## Changes to review (against the base branch)\n\n\`\`\`diff\n${c.diff}\n\`\`\``);
  return out.join('\n\n');
}

export interface ClarifyContext {
  root: string;
  project: ProjectConfig;
  item: BacklogItem;
  /** Questions asked before and the owner's answers, which are settled. */
  previous?: { questions: { id: string; question: string }[]; answers: Record<string, { answer: string }> };
}

/** The analyst's input: the requirement, the product around it, and what the owner already answered. */
export function clarifyPrompt(c: ClarifyContext): string {
  const { project, item } = c;
  const out: string[] = [`# Product: ${project.name} (stage: ${project.stage})`];
  if (project.hypothesis) out.push(`Hypothesis: ${project.hypothesis}`);
  const brief = readIfExists(join(c.root, 'product', 'brief.md'));
  if (brief) out.push(`## Product brief\n\n${brief}`);
  const memory = readIfExists(join(c.root, '.factory', 'memory', 'context.md'));
  if (memory) out.push(`## Project memory\n\n${memory}`);
  out.push(`## Requirement ${item.id}: ${item.title}\n\n${item.body || '(no notes)'}`);
  if (item.criteria?.length) out.push(`Acceptance criteria named: ${item.criteria.join(', ')}`);
  if (item.spec) {
    const spec = readIfExists(join(c.root, item.spec));
    out.push(spec ? `## Spec (${item.spec})\n\n${spec}` : `Spec ${item.spec} is missing.`);
  }
  const answered = c.previous?.questions.filter((q) => c.previous!.answers[q.id]) ?? [];
  if (answered.length) {
    out.push(`## Already answered by the owner (settled; do not ask again)\n\n${answered.map((q) => `- ${q.id}. ${q.question}\n  ${c.previous!.answers[q.id]!.answer}`).join('\n')}`);
  }
  return out.join('\n\n');
}
