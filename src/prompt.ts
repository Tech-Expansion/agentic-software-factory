import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factoryRoot } from './paths.js';
import type { BacklogItem } from './backlog.js';
import type { ProjectConfig } from './config.js';

const stripFront = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

export function loadRole(name: string): string {
  const file = join(factoryRoot, 'agents', `${name}.md`);
  if (!existsSync(file)) throw new Error(`unknown role: ${name}`);
  return stripFront(readFileSync(file, 'utf8'));
}

export function loadSkill(name: string): string {
  const file = join(factoryRoot, 'skills', name, 'SKILL.md');
  if (!existsSync(file)) throw new Error(`unknown skill: ${name}`);
  return stripFront(readFileSync(file, 'utf8'));
}

/** Role first, then only the skills the step names. Nothing item-specific, so it stays cacheable across items. */
export function systemPrompt(role: string, skills: string[]): string {
  const parts = [`# Your role\n\n${loadRole(role)}`];
  for (const s of skills) parts.push(`# Skill: ${s}\n\n${loadSkill(s)}`);
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
