import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BacklogItem } from './backlog.js';
import { formatChecks, runChecks } from './checks.js';
import { runtimeFor, validate, vendorSchema, type Policy, type ProjectConfig, type RuntimeName } from './config.js';
import { commitAll, ensureWorktree, git, isAncestor, restorePaths, stagedDiff, stageAndList } from './git.js';
import { matchesAny } from './glob.js';
import { findSecrets, testTampering } from './integrity.js';
import type { StopHookConfig, StopHookCount } from './hooks/stop-checks.js';
import { factoryRoot, type ProductPaths } from './paths.js';
import { itemPrompt, systemPrompt, type ItemContext } from './prompt.js';
import { appendEvent, saveTranscript, type RunEvent } from './runlog.js';
import type { AgentResult, Runtime } from './runtimes/types.js';
import { loadState, saveState, type ItemState } from './state.js';
import { loadWorkflow, type AgentStep, type Workflow } from './workflow.js';

export interface EngineContext {
  paths: ProductPaths;
  project: ProjectConfig;
  policy: Policy;
  runtime: (name: RuntimeName) => Runtime;
  log?: (msg: string) => void;
  /** The workflow items run through; the feature workflow when unset. */
  workflow?: Workflow;
}

export interface ItemOutcome {
  id: string;
  /**
   * merged: passed review and merged into the integration branch on its own (by `asf run`). paused: the CLI hit a
   * usage limit; the item resumes from where it was once the quota resets.
   */
  state: 'review' | 'blocked' | 'plan-review' | 'merged' | 'paused';
  /** For paused: when the quota resets (ms since the epoch), if the CLI said. */
  resumeAt?: number;
  reason?: string;
  tokens: number;
  flags: string[];
}

interface Verdict {
  verdict: 'pass' | 'fail';
  criteria: { id: string; status: 'met' | 'not_met' | 'unverified'; evidence: string }[];
  findings: { severity: 'blocker' | 'major' | 'minor'; message: string }[];
  summary: string;
}

/** True when a failed call hit the subscription's usage limit rather than something a person must fix. */
export function rateLimited(r: AgentResult): boolean {
  const status = r.rateLimit?.status;
  if (status && status !== 'allowed' && status !== 'allowed_warning') return true;
  return /usage limit|rate limit|too many requests|\b429\b|quota/i.test(r.error ?? '');
}

const PLAN_STEP: AgentStep = { id: 'plan', kind: 'agent', role: 'tech-lead', skills: ['plan-change'], access: 'read' };

interface Plan {
  approach: string;
  files: string[];
  tests: string[];
  risks: string[];
}

export function formatPlan(p: Plan): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n') || '- (none)';
  return `${p.approach}\n\nFiles:\n${list(p.files)}\n\nTests:\n${list(p.tests)}\n\nRisks:\n${list(p.risks)}`;
}

/** The branch items start from: the integration branch, created from the base branch the first time. */
export function integrationBase(root: string, project: ProjectConfig): string {
  const base = project.base_branch ?? 'main';
  const integration = project.integration_branch;
  if (!integration) return base;
  if (!git(root, ['branch', '--list', integration]).trim()) git(root, ['branch', integration, base]);
  return integration;
}

/** The runner does not take "pass" on trust: an unmet criterion or a blocker finding fails the item. */
export function verdictFails(v: Verdict): string | undefined {
  const unmet = v.criteria.filter((c) => c.status === 'not_met');
  const blockers = v.findings.filter((f) => f.severity === 'blocker');
  if (v.verdict === 'pass' && !unmet.length && !blockers.length) return undefined;
  const lines = [`Verifier: ${v.summary}`];
  for (const c of v.criteria.filter((c) => c.status !== 'met')) lines.push(`- ${c.id} ${c.status}: ${c.evidence}`);
  for (const f of v.findings) lines.push(`- [${f.severity}] ${f.message}`);
  return lines.join('\n');
}

/** The Stop hook for one build call: its settings, and how many rounds it ran once the call is over. */
function stopHook(paths: ProductPaths, item: string, name: string, cfg: Omit<StopHookConfig, 'counter'>) {
  const dir = join(paths.runs, 'hooks', item);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  const counter = join(dir, `${name}.count.json`);
  rmSync(counter, { force: true });
  writeFileSync(file, JSON.stringify({ ...cfg, counter } satisfies StopHookConfig) + '\n');
  const script = join(factoryRoot, 'dist', 'hooks', 'stop-checks.js');
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(script)} ${quote(file)}`, timeout: 1800 }] }] },
    count: (): StopHookCount | undefined => (existsSync(counter) ? (JSON.parse(readFileSync(counter, 'utf8')) as StopHookCount) : undefined),
  };
}

export async function runItem(ctx: EngineContext, item: BacklogItem, workflow: Workflow = ctx.workflow ?? loadWorkflow('feature')): Promise<ItemOutcome> {
  const { paths, project, policy } = ctx;
  // Items branch from the integration branch when there is one, so each builds on what is already merged.
  const base = integrationBase(paths.root, project);
  const log = ctx.log ?? (() => {});
  const all = loadState(paths.state);
  const prev = all.items[item.id];
  const branch = `asf/${item.id}`;
  const worktree = join(paths.worktrees, item.id);
  const st: ItemState = {
    state: 'in-progress',
    branch,
    worktree,
    attempts: 0,
    tokens: prev?.tokens ?? 0,
    feedback: prev?.feedback,
    updated_at: new Date().toISOString(),
  };
  const save = () => {
    st.updated_at = new Date().toISOString();
    const s = loadState(paths.state);
    s.items[item.id] = st;
    saveState(paths.state, s);
  };
  const event = (e: Omit<RunEvent, 'at' | 'item'>) => appendEvent(paths.runs, { at: new Date().toISOString(), item: item.id, ...e });
  const finish = (state: 'review' | 'blocked' | 'plan-review', reason?: string, flags: string[] = []): ItemOutcome => {
    st.state = state;
    st.reason = reason;
    st.flags = flags;
    save();
    event({ step: 'item', kind: 'item', outcome: state, detail: reason });
    log(`${item.id} ${state}${reason ? `: ${reason}` : ''}`);
    return { id: item.id, state, reason, tokens: st.tokens, flags };
  };

  // A worktree made now needs the setup commands, whether the item is new or was reset.
  /** A runtime error: a usage limit pauses the item; anything else (sign-in, a crash) blocks it, without retrying. */
  const stopped = (r: AgentResult, runtimeName: string, stepId: string): ItemOutcome => {
    if (!rateLimited(r)) return finish('blocked', `${runtimeName} failed in ${stepId}: ${r.error}`);
    st.state = 'rework';
    st.reason = `paused by a usage limit in ${stepId}: ${r.error ?? r.rateLimit?.status}`;
    save();
    event({ step: stepId, kind: 'item', outcome: 'paused', detail: st.reason });
    log(`${item.id} paused: ${st.reason}`);
    return { id: item.id, state: 'paused', reason: st.reason, tokens: st.tokens, flags: [], resumeAt: r.rateLimit?.resetsAt ? r.rateLimit.resetsAt * 1000 : undefined };
  };

  const fresh = !existsSync(worktree);
  ensureWorktree(paths.root, worktree, branch, base);
  // Tests written for an earlier run stay locked, as long as the branch still has them.
  if (prev?.tests && isAncestor(worktree, prev.tests.commit)) st.tests = prev.tests;
  st.plan = prev?.plan;
  save();
  event({ step: 'item', kind: 'item', outcome: 'started' });
  log(`${item.id} started in ${worktree}`);

  if (fresh && project.commands.setup?.length) {
    const setup = runChecks(worktree, project.commands.setup, policy.sandbox);
    event({ step: 'setup', kind: 'checks', outcome: setup.every((r) => r.ok) ? 'passed' : 'failed' });
    if (!setup.every((r) => r.ok)) return finish('blocked', `setup failed:\n${formatChecks(setup)}`);
  }

  const commands = [...(project.commands.setup ?? []), ...project.commands.check];
  const testsStep = workflow.steps.find((s): s is AgentStep => s.kind === 'agent' && s.scope === 'tests');
  const steps = workflow.steps.filter((s) => s !== testsStep);

  const callAgent = async (step: AgentStep, attempt: number, extra: Pick<ItemContext, 'feedback' | 'checks' | 'diff'>, schema?: string) => {
    const runtimeName = runtimeFor(project, step.role);
    const locked = step.scope === 'tests' ? [] : (st.tests?.files ?? []);
    // A builder on Claude Code runs the checks itself before it may finish, so a failure is fixed in the same session.
    const stop =
      step.access === 'write' && !step.scope && runtimeName === 'claude-code' && policy.check_rounds_in_session > 0 && project.commands.check.length
        ? stopHook(paths, item.id, `a${attempt}-${step.id}`, { cwd: worktree, commands: project.commands.check, sandbox: policy.sandbox, max: policy.check_rounds_in_session })
        : undefined;
    const result = await ctx.runtime(runtimeName).call({
      cwd: worktree,
      systemPrompt: systemPrompt(step.role, step.skills),
      prompt: itemPrompt({
        root: worktree,
        project,
        item,
        attempt,
        maxAttempts: policy.max_attempts,
        ...extra,
        lockedTests: step.access === 'write' ? locked : undefined,
        plan: st.plan?.approved ? st.plan.text : undefined,
      }),
      access: step.access,
      model: project.models?.[step.role],
      schema: schema ? vendorSchema(schema) : step.output === 'verdict' ? vendorSchema('verdict') : undefined,
      allowedCommands: commands,
      deniedCommands: policy.denied_commands,
      protectedPaths: [...policy.protected_paths, ...locked],
      writeOnly: step.scope === 'tests' ? policy.test_paths : undefined,
      sandbox: policy.sandbox,
      hooks: stop?.hooks,
    });
    if (result.transcript) saveTranscript(paths.runs, item.id, `a${attempt}-${step.id}`, result.transcript);
    st.tokens += result.tokens.total;
    event({
      attempt,
      step: step.id,
      kind: 'agent',
      role: step.role,
      runtime: runtimeName,
      model: project.models?.[step.role],
      tokens: result.tokens,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
      outcome: result.ok ? 'ok' : 'error',
      detail: result.error,
      denied: result.denied,
    });
    log(`${item.id} attempt ${attempt} ${step.id} (${runtimeName}): ${result.ok ? 'ok' : 'error'}, ${result.tokens.total} tokens`);
    const rounds = stop?.count();
    if (rounds?.rounds) {
      event({ attempt, step: step.id, kind: 'checks', outcome: rounds.passed ? 'passed in session' : 'failed in session', detail: `${rounds.rounds} round(s), sent back ${rounds.blocked} time(s)` });
    }
    return { result, runtimeName };
  };

  /** Locked test files the staged change differs on. */
  const lockedChanges = () =>
    st.tests ? git(worktree, ['diff', '--cached', '--name-only', st.tests.commit, '--', ...st.tests.files]).split('\n').filter(Boolean) : [];

  // A high-risk item gets a plan the owner approves before anything is written.
  if (item.risk === 'high' && !st.plan?.approved) {
    if (st.tokens >= policy.max_tokens_per_item) return finish('blocked', `token budget per item reached (${st.tokens})`);
    const { result, runtimeName } = await callAgent(PLAN_STEP, 1, { feedback: st.feedback }, 'plan');
    if (!result.ok) return stopped(result, runtimeName, 'plan');
    const errors = validate('plan', result.structured);
    if (errors.length) return finish('blocked', `plan returned an invalid plan: ${errors.join('; ')}`);
    st.plan = { text: formatPlan(result.structured as Plan) };
    st.feedback = undefined;
    return finish('plan-review', 'the plan waits for your approval');
  }

  if (testsStep && !st.tests) {
    if (st.tokens >= policy.max_tokens_per_item) return finish('blocked', `token budget per item reached (${st.tokens})`);
    const { result, runtimeName } = await callAgent(testsStep, 1, {});
    // A runtime error is usually a limit or a sign-in problem; retrying would only burn tokens.
    if (!result.ok) return stopped(result, runtimeName, testsStep.id);
    const changed = stageAndList(worktree, base);
    const other = changed.filter((f) => !matchesAny(f, policy.test_paths) || matchesAny(f, policy.protected_paths));
    if (other.length) {
      restorePaths(worktree, base, other);
      event({ attempt: 1, step: testsStep.id, kind: 'checks', outcome: 'reverted', detail: `not test files: ${other.join(', ')}` });
    }
    const files = changed.filter((f) => !other.includes(f));
    stageAndList(worktree, base);
    const secrets = findSecrets(git(worktree, ['diff', '--cached', '-U0', base]), policy.secret_patterns);
    if (secrets.length) return finish('blocked', `the acceptance tests contain what looks like a secret:\n${secrets.map((x) => `- ${x}`).join('\n')}`);
    if (files.length && commitAll(worktree, `test: acceptance tests for ${item.title}\n\nBacklog: ${item.id}\n`)) {
      st.tests = { commit: git(worktree, ['rev-parse', 'HEAD']).trim(), files };
      const red = runChecks(worktree, project.commands.check, policy.sandbox);
      const green = red.every((r) => r.ok);
      // Tests that already pass test nothing new, unless the item is a refactor. Recorded, not enforced.
      event({ attempt: 1, step: testsStep.id, kind: 'checks', outcome: green ? 'passed' : 'failed', detail: green ? 'the acceptance tests pass before the build' : undefined });
    } else {
      event({ attempt: 1, step: testsStep.id, kind: 'checks', outcome: 'no tests', detail: 'the tests step wrote no test files' });
    }
    save();
  }

  let feedback = st.feedback;
  for (let attempt = 1; attempt <= policy.max_attempts; attempt++) {
    st.attempts = attempt;
    let checksText: string | undefined;
    let failed: string | undefined;

    for (const step of steps) {
      if (step.kind === 'checks') {
        const results = runChecks(worktree, project.commands.check, policy.sandbox);
        const ok = results.every((r) => r.ok);
        checksText = formatChecks(results);
        event({ attempt, step: step.id, kind: 'checks', outcome: ok ? 'passed' : 'failed', duration_ms: results.reduce((n, r) => n + r.durationMs, 0) });
        log(`${item.id} attempt ${attempt} ${step.id}: ${ok ? 'passed' : 'failed'}`);
        if (!ok) {
          failed = `The checks failed:\n${checksText}`;
          break;
        }
        continue;
      }

      if (st.tokens >= policy.max_tokens_per_item) return finish('blocked', `token budget per item reached (${st.tokens})`);
      const diff = step.access === 'read' ? (stageAndList(worktree, base), stagedDiff(worktree, base, 60_000)) : undefined;
      const { result, runtimeName } = await callAgent(step, attempt, {
        feedback: step.access === 'write' ? feedback : undefined,
        checks: step.access === 'read' ? checksText : undefined,
        diff,
      });
      // A runtime error is usually a limit or a sign-in problem; retrying would only burn tokens.
      if (!result.ok) return stopped(result, runtimeName, step.id);

      if (step.access === 'write') {
        const changed = stageAndList(worktree, base);
        const touched = changed.filter((f) => matchesAny(f, policy.protected_paths));
        if (touched.length) {
          restorePaths(worktree, base, touched);
          failed = `You changed protected files. They were put back; do not change them: ${touched.join(', ')}`;
          break;
        }
        const locked = lockedChanges();
        if (locked.length) {
          restorePaths(worktree, st.tests!.commit, locked);
          failed = `The acceptance tests are locked, and your changes to them were put back: ${locked.join(', ')}. Make them pass by changing the code; if a test is wrong, say so under "Assumptions".`;
          break;
        }
        if (!stageAndList(worktree, st.tests?.commit ?? base).length) {
          failed = 'No file was changed.';
          break;
        }
        const tampered = testTampering(worktree, base, policy.test_paths);
        if (tampered.length) {
          failed = `Tests may not be deleted, skipped or focused to get an item through. Undo this, and fix the code instead (if a test is wrong, say so in your summary):\n${tampered.map((t) => `- ${t}`).join('\n')}`;
          break;
        }
        st.summary = result.text.slice(0, 4000);
      }

      if (step.output === 'verdict') {
        const errors = validate('verdict', result.structured);
        if (errors.length) return finish('blocked', `${step.id} returned an invalid verdict: ${errors.join('; ')}`);
        failed = verdictFails(result.structured as Verdict);
        if (failed) break;
      }
    }

    if (!failed) {
      const changed = stageAndList(worktree, base);
      // Checked again here: a read-only step must not be able to slip a protected change into the commit.
      const late = [...changed.filter((f) => matchesAny(f, policy.protected_paths)), ...lockedChanges()];
      if (late.length) {
        restorePaths(worktree, base, changed.filter((f) => matchesAny(f, policy.protected_paths)));
        if (st.tests) restorePaths(worktree, st.tests.commit, lockedChanges());
        return finish('blocked', `protected files changed outside a build step: ${late.join(', ')}`);
      }
      const secrets = findSecrets(git(worktree, ['diff', '--cached', '-U0', base]), policy.secret_patterns);
      if (secrets.length) {
        failed = `The change contains what looks like a secret. Remove it; credentials never go into the repository:\n${secrets.map((x) => `- ${x}`).join('\n')}`;
      }
    }

    if (!failed) {
      const changed = stageAndList(worktree, base);
      // Anything flagged waits for the owner on its own, even with an integration branch.
      const flags = changed.filter((f) => matchesAny(f, policy.approval_paths) || matchesAny(f, policy.sensitive_paths));
      if (item.risk === 'high') flags.push('risk: high');
      commitAll(worktree, `feat: ${item.title}\n\nBacklog: ${item.id}\n\n${st.summary ?? ''}`.trim() + '\n');
      st.feedback = undefined;
      return finish('review', undefined, flags);
    }
    feedback = failed;
    st.feedback = failed;
    save();
    event({ attempt, step: 'attempt', kind: 'item', outcome: 'failed', detail: failed.slice(0, 4000) });
  }
  return finish('blocked', `still failing after ${policy.max_attempts} attempts`);
}
