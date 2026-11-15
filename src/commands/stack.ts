import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { modelFor, runtimeFor, validate, vendorSchema } from '../config.js';
import type { EngineContext } from '../engine.js';
import { commitFiles } from '../git.js';
import { systemPrompt } from '../prompt.js';
import { saveTranscript } from '../runlog.js';

interface Stack {
  decided: boolean;
  reason: string;
  stack?: string;
  title?: string;
  adr?: string;
  setup?: string[];
  check?: string[];
}

const PROMPT = 'Choose the stack for this product from what discovery settled, and record it as an ADR.';

/**
 * After discovery, while the product has no checks: the tech lead chooses the stack from the brief and records it as
 * an ADR, and the runner sets the commands it gives. The owner described the product; the technology is the team's.
 */
export async function chooseStack(ctx: Pick<EngineContext, 'paths' | 'project' | 'policy' | 'runtime'>): Promise<string | undefined> {
  const { paths, project, policy } = ctx;
  if (project.commands.check.length) return undefined;
  const runtimeName = runtimeFor(project, 'tech-lead');
  const result = await ctx.runtime(runtimeName).call({
    cwd: paths.root,
    systemPrompt: systemPrompt('tech-lead', ['choose-stack'], paths.factory),
    prompt: PROMPT,
    access: 'read',
    model: modelFor(project, 'tech-lead'),
    schema: vendorSchema('stack'),
    allowedCommands: [],
    deniedCommands: policy.denied_commands,
    protectedPaths: policy.protected_paths,
    sandbox: policy.sandbox,
  });
  if (result.transcript) saveTranscript(paths.runs, 'stack', `stack-${Date.now()}`, result.transcript);
  const s = result.structured as Stack | undefined;
  const errors = result.ok ? validate('stack', s) : [result.error ?? 'failed'];
  if (errors.length || !s) return `the tech lead could not choose the stack: ${errors.join('; ')}`;
  if (!s.decided || !s.adr || !s.check?.length) return `the tech lead chooses the stack once the brief says more: ${s.reason}`;

  const adrDir = join(paths.root, 'docs', 'adr');
  const n = Math.max(0, ...(existsSync(adrDir) ? readdirSync(adrDir) : []).map((f) => Number(/^(\d{4})-/.exec(f)?.[1] ?? 0))) + 1;
  const title = s.title ?? `The stack: ${s.stack ?? ''}`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const adr = join(adrDir, `${String(n).padStart(4, '0')}-${slug}.md`);
  writeFileSync(adr, `# ${String(n).padStart(4, '0')}. ${title}\n\nStatus: accepted\nDate: ${new Date().toISOString().slice(0, 10)}\nDeciders: tech lead\n\n${s.adr.trim()}\n`);
  const projectFile = join(paths.factory, 'project.yaml');
  const doc = parseDocument(readFileSync(projectFile, 'utf8'));
  doc.setIn(['commands', 'setup'], s.setup ?? []);
  doc.setIn(['commands', 'check'], s.check);
  writeFileSync(projectFile, doc.toString());
  commitFiles(paths.root, [adr, projectFile], `docs(adr): ${String(n).padStart(4, '0')} ${title}\n`);
  return `the tech lead chose the stack: ${s.stack ?? title} (docs/adr/${String(n).padStart(4, '0')}-${slug}.md); checks: ${s.check.join(', ')}`;
}
