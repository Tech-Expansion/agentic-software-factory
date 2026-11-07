import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadBacklog } from './backlog.js';
import { formatChecks, runChecks } from './checks.js';
import { ConfigError, validate } from './config.js';
import type { EngineContext } from './engine.js';
import { git } from './git.js';
import { matchesAny } from './glob.js';
import { readEvents } from './runlog.js';
import { openProduct } from './commands/context.js';
import { init } from './commands/init.js';
import { approve } from './commands/review.js';
import { run } from './commands/run.js';

/**
 * An eval case is a small product with a backlog, plus acceptance tests the agents never see.
 * Folder layout: `case.yaml`, `product/` (laid over a fresh `asf init`), `hidden/` (copied in after delivery).
 */
export interface EvalCase {
  id: string;
  kind: 'build';
  stack: string;
  description: string;
  tags?: string[];
  hidden: { check: string[] };
  dir: string;
}

export interface ItemResult {
  id: string;
  state: string;
  attempts: number;
  reason?: string;
}

export interface CaseResult {
  id: string;
  stack: string;
  tags: string[];
  delivered: boolean;
  /** Every item that was ready got through on its first attempt. */
  firstAttempt: boolean;
  items: ItemResult[];
  hidden?: { ok: boolean; output: string };
  /** Hard-gate breaches. Any one of them fails the whole eval run. */
  breaches: string[];
  tokens: number;
  agentSteps: number;
  durationMs: number;
  error?: string;
  /** Kept for inspection with `--keep`. */
  root?: string;
}

export function loadCases(dir: string, only?: string): EvalCase[] {
  if (!existsSync(dir)) throw new ConfigError(`no eval cases in ${dir}`);
  const cases: EvalCase[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'case.yaml');
    if (!existsSync(file)) continue;
    const data = parse(readFileSync(file, 'utf8')) as Omit<EvalCase, 'dir'>;
    const errors = validate('eval-case', data);
    if (errors.length) throw new ConfigError(`${file}:\n  ${errors.join('\n  ')}`);
    if (data.id !== name) throw new ConfigError(`${file}: id ${data.id} does not match its folder ${name}`);
    if (!existsSync(join(dir, name, 'product'))) throw new ConfigError(`${join(dir, name)}: no product/ folder`);
    if (!only || data.id === only) cases.push({ ...data, dir: join(dir, name) });
  }
  if (only && !cases.length) throw new ConfigError(`no eval case ${only} in ${dir}`);
  return cases;
}

const head = (root: string, ref: string) => git(root, ['rev-parse', ref]).trim();

/**
 * Builds a case end to end the way an unattended run would: one item at a time, each merged as soon as it passes
 * review (standing in for the owner's approval), then the hidden checks on the result.
 */
export async function runCase(
  c: EvalCase,
  opts: { context?: Partial<EngineContext>; keep?: boolean; log?: (msg: string) => void } = {},
): Promise<CaseResult> {
  const started = Date.now();
  const root = mkdtempSync(join(tmpdir(), `asf-eval-${c.id}-`));
  const result: CaseResult = {
    id: c.id,
    stack: c.stack,
    tags: c.tags ?? [],
    delivered: false,
    firstAttempt: false,
    items: [],
    breaches: [],
    tokens: 0,
    agentSteps: 0,
    durationMs: 0,
  };
  try {
    init(root, c.id);
    cpSync(join(c.dir, 'product'), root, { recursive: true });
    git(root, ['config', 'user.name', 'asf eval']);
    git(root, ['config', 'user.email', 'asf-eval@example.invalid']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'eval fixture']);

    const { paths, project, policy } = openProduct(root);
    const base = project.base_branch ?? 'main';
    const initial = loadBacklog(paths.backlog);
    if (initial.errors.length) throw new ConfigError(`fixture backlog: ${initial.errors.join('; ')}`);
    const drafts = initial.items.filter((i) => i.status === 'draft').map((i) => i.id);
    const ready = initial.items.filter((i) => i.status === 'ready').map((i) => i.id);

    for (let guard = 0; guard <= ready.length; guard++) {
      const baseHead = head(root, base);
      const [outcome] = await run({ root, context: opts.context, log: opts.log });
      if (!outcome) break;
      if (head(root, base) !== baseHead) result.breaches.push(`${outcome.id}: ${base} changed before approval`);
      if (outcome.state !== 'review') continue;
      const changed = git(root, ['diff', '--name-only', `${base}...asf/${outcome.id}`]).split('\n').filter(Boolean);
      const touched = changed.filter((f) => matchesAny(f, policy.protected_paths));
      if (touched.length) result.breaches.push(`${outcome.id}: protected paths changed: ${touched.join(', ')}`);
      approve(outcome.id, root);
    }

    const events = readEvents(paths.runs);
    const agent = events.filter((e) => e.kind === 'agent');
    result.tokens = agent.reduce((n, e) => n + (e.tokens?.total ?? 0), 0);
    result.agentSteps = agent.length;
    const final = loadBacklog(paths.backlog).items;
    for (const id of ready) {
      const attempts = Math.max(0, ...agent.filter((e) => e.item === id).map((e) => e.attempt ?? 1));
      const last = events.filter((e) => e.item === id && e.kind === 'item').at(-1);
      const done = final.find((i) => i.id === id)?.status === 'done';
      result.items.push({ id, state: done ? 'done' : (last?.outcome ?? 'not run'), attempts, reason: done ? undefined : last?.detail });
    }
    for (const id of drafts) {
      if (events.some((e) => e.item === id)) result.breaches.push(`${id}: a draft item was built`);
    }

    if (existsSync(join(c.dir, 'hidden'))) cpSync(join(c.dir, 'hidden'), root, { recursive: true });
    const checks = runChecks(root, c.hidden.check);
    result.hidden = { ok: checks.every((r) => r.ok), output: formatChecks(checks) };
    const allDone = result.items.every((i) => i.state === 'done');
    result.delivered = allDone && result.hidden.ok && !result.breaches.length;
    result.firstAttempt = result.delivered && result.items.every((i) => i.attempts === 1);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.durationMs = Date.now() - started;
    if (opts.keep) result.root = root;
    else rmSync(root, { recursive: true, force: true });
  }
  return result;
}

/** Wilson score interval: honest bounds for a rate measured on few cases. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - margin) / d), Math.min(1, (centre + margin) / d)];
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
};

export interface EvalSummary {
  cases: number;
  delivered: number;
  rate: number;
  interval: [number, number];
  firstAttempt: number;
  breaches: number;
  errors: number;
  tokensMedian: number;
  tokensP90: number;
}

export function summarize(results: CaseResult[]): EvalSummary {
  const delivered = results.filter((r) => r.delivered).length;
  const tokens = results.map((r) => r.tokens);
  return {
    cases: results.length,
    delivered,
    rate: results.length ? delivered / results.length : 0,
    interval: wilson(delivered, results.length),
    firstAttempt: results.filter((r) => r.firstAttempt).length,
    breaches: results.reduce((n, r) => n + r.breaches.length, 0),
    errors: results.filter((r) => r.error).length,
    tokensMedian: quantile(tokens, 0.5),
    tokensP90: quantile(tokens, 0.9),
  };
}
