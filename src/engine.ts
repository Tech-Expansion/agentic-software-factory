import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBacklog, setStatus, subject, type BacklogItem } from './backlog.js';
import { formatChecks, runChecks } from './checks.js';
import { modelFor, runtimeFor, validate, vendorSchema, type Policy, type ProjectConfig, type RuntimeName } from './config.js';
import { commitAll, commitFiles, currentBranch, ensureWorktree, git, isAncestor, removeWorktree, restorePaths, stagedDiff, stageAndList } from './git.js';
import { matchesAny } from './glob.js';
import { findSecrets, testTampering } from './integrity.js';
import type { StopHookConfig, StopHookCount } from './hooks/stop-checks.js';
import { factoryRoot, type ProductPaths } from './paths.js';
import { itemPrompt, systemPrompt, type ItemContext } from './prompt.js';
import { appendEvent, budgetTokens, readEvents, saveTranscript, type RunEvent } from './runlog.js';
import type { AgentResult, Runtime } from './runtimes/types.js';
import { loadState, saveState, type ItemState } from './state.js';
import { loadWorkflow, writesTests, type AgentStep, type Workflow } from './workflow.js';

export interface EngineContext {
  paths: ProductPaths;
  project: ProjectConfig;
  policy: Policy;
  runtime: (name: RuntimeName) => Runtime;
  log?: (msg: string) => void;
  /** The workflow every item runs through, whatever it asks for: an ablation in `asf eval`. */
  workflow?: Workflow;
}

export interface ItemOutcome {
  id: string;
  /**
   * merged: passed review and merged into the base branch on its own (by `asf run`). paused: the CLI hit a
   * usage limit; the item resumes from where it was once the quota resets. split: the product owner replaced it with
   * smaller items.
   */
  state: 'review' | 'blocked' | 'plan-review' | 'merged' | 'paused' | 'split';
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
  /** Decisions for the owner, which hold the change for them without failing it. */
  escalate?: string[];
}

/** True when a failed call hit the subscription's usage limit rather than something a person must fix. */
/** How the CLIs word a subscription or API limit, for when no rate-limit event says so. */
export const LIMIT = /usage limit|rate limit|too many requests|\b429\b|quota|hit your [\w -]*limit/i;

export function rateLimited(r: AgentResult): boolean {
  const status = r.rateLimit?.status;
  if (status && status !== 'allowed' && status !== 'allowed_warning') return true;
  return LIMIT.test(r.error ?? '');
}

const PLAN_STEP: AgentStep = { id: 'plan', kind: 'agent', role: 'tech-lead', skills: ['plan-change'], access: 'read' };
const DIAGNOSE_STEP: AgentStep = { id: 'diagnose', kind: 'agent', role: 'tech-lead', skills: ['diagnose-failure'], access: 'read' };
const RESCOPE_STEP: AgentStep = { id: 'rescope', kind: 'agent', role: 'product-owner', skills: ['rescope-item'], access: 'read' };

interface Diagnosis {
  diagnosis: string;
  cause: 'code' | 'requirement';
  plan?: string;
}

interface Rescope {
  decision: 'split' | 'ask';
  reason: string;
  items?: { title: string; body: string }[];
  question?: string;
  options?: string[];
  recommended?: string;
}

interface Plan {
  approach: string;
  files: string[];
  tests: string[];
  risks: string[];
  owner_decisions?: string[];
}

export function formatPlan(p: Plan): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n') || '- (none)';
  const asks = p.owner_decisions?.length ? `\n\nFor the owner to decide:\n${list(p.owner_decisions)}` : '';
  return `${p.approach}\n\nFiles:\n${list(p.files)}\n\nTests:\n${list(p.tests)}\n\nRisks:\n${list(p.risks)}${asks}`;
}

/**
 * The workflow an item runs: its own `workflow:`, else the product's, else feature. A high-risk item always runs
 * feature, which must write acceptance tests first; a product that replaced feature with one that does not gets the
 * item blocked instead of built untested.
 */
export function selectWorkflow(paths: ProductPaths, project: ProjectConfig, item: BacklogItem): Workflow {
  if (item.risk === 'high') return testedFeature(paths, 'a high-risk item');
  return loadWorkflow(item.workflow ?? project.workflow ?? 'feature', [], paths.factory);
}

function testedFeature(paths: ProductPaths, who: string): Workflow {
  const wf = loadWorkflow('feature', [], paths.factory);
  if (!writesTests(wf)) throw new Error(`the product's feature workflow has no tests step, and ${who} gets acceptance tests first`);
  return wf;
}

/** A specialist's step runs only for a product that turned the specialist on. */
export const specialistOn = (step: AgentStep, project: ProjectConfig) =>
  !step.specialist || (project.specialists ?? []).includes(step.role);

/** Whether a step with `when` applies to this change: a changed file in one of its paths, or the item's risk. */
export function stepApplies(step: AgentStep, item: BacklogItem, changed: string[], policy: Policy, project: ProjectConfig): boolean {
  const w = step.when;
  if (!w) return true;
  if (w.risk && item.risk === w.risk) return true;
  const named: Record<string, string[]> = { ...project.paths, sensitive: policy.sensitive_paths, approval: policy.approval_paths };
  const globs = (w.touches ?? []).flatMap((t) => (/[/*.]/.test(t) ? [t] : (named[t] ?? [])));
  return globs.length > 0 && changed.some((f) => matchesAny(f, globs));
}

/**
 * The production branch, created the first time from the base branch (or from the remote's, if it has one): what was
 * there before the team built anything counts as released.
 */
export function productionBranch(root: string, project: ProjectConfig): string {
  const production = project.production_branch ?? 'production';
  if (git(root, ['branch', '--list', production]).trim()) return production;
  const remote = project.remote && `refs/remotes/${project.remote}/${production}`;
  const from = remote && git(root, ['rev-parse', '-q', '--verify', remote], true).trim() ? remote : (project.base_branch ?? 'main');
  git(root, ['branch', production, from]);
  return production;
}

/** The runner does not take "pass" on trust: an unmet criterion or a blocker finding fails the item. */
export function verdictFails(v: Verdict, who = 'QA'): string | undefined {
  const unmet = v.criteria.filter((c) => c.status === 'not_met');
  const blockers = v.findings.filter((f) => f.severity === 'blocker');
  if (v.verdict === 'pass' && !unmet.length && !blockers.length) return undefined;
  const lines = [`${who}: ${v.summary}`];
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
  // Claude Code hands the command to a shell: single quotes for a POSIX one, double quotes on Windows, which both
  // cmd.exe and Git Bash read.
  const quote = process.platform === 'win32' ? (s: string) => `"${s}"` : (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(script)} ${quote(file)}`, timeout: 1800 }] }] },
    count: (): StopHookCount | undefined => (existsSync(counter) ? (JSON.parse(readFileSync(counter, 'utf8')) as StopHookCount) : undefined),
  };
}

/**
 * Runs one item. `given` is the workflow to use instead of the item's own: feature, when a quick change escalates.
 * Whatever breaks in the runner itself (git, the sandbox, a file) blocks the item with the error as its reason, so it
 * never stays "in progress" with nobody told.
 */
export async function runItem(ctx: EngineContext, item: BacklogItem, given?: Workflow): Promise<ItemOutcome> {
  try {
    return await buildItem(ctx, item, given);
  } catch (err) {
    const reason = `the runner failed: ${(err as Error).message}`;
    const at = new Date().toISOString();
    const state = loadState(ctx.paths.state);
    const prev = state.items[item.id];
    state.items[item.id] = { branch: `asf/${item.id}`, worktree: join(ctx.paths.worktrees, item.id), attempts: 0, tokens: 0, ...prev, state: 'blocked', reason, flags: [], updated_at: at };
    saveState(ctx.paths.state, state);
    appendEvent(ctx.paths.runs, { at, item: item.id, step: 'item', kind: 'item', outcome: 'blocked', detail: reason });
    ctx.log?.(`${item.id} blocked: ${reason}`);
    return { id: item.id, state: 'blocked', reason, tokens: prev?.tokens ?? 0, flags: [] };
  }
}

async function buildItem(ctx: EngineContext, item: BacklogItem, given?: Workflow): Promise<ItemOutcome> {
  const { paths, project, policy } = ctx;
  // Items branch from the base branch, so each builds on what is already merged; production is set apart first.
  const baseBranch = project.base_branch ?? 'main';
  productionBranch(paths.root, project);
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
    escalated: prev?.escalated,
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

  let workflow: Workflow;
  try {
    workflow = given ?? ctx.workflow ?? selectWorkflow(paths, project, item);
  } catch (err) {
    return finish('blocked', (err as Error).message);
  }

  const fresh = !existsSync(worktree);
  ensureWorktree(paths.root, worktree, branch, baseBranch);
  // What the item changed is measured from where it forked: the base branch moves while it runs, as others merge.
  const base = git(worktree, ['merge-base', 'HEAD', baseBranch]).trim();
  // Tests written for an earlier run stay locked, as long as the branch still has them.
  if (prev?.tests && isAncestor(worktree, prev.tests.commit)) st.tests = prev.tests;
  st.plan = prev?.plan;
  st.setup = !fresh && prev?.setup;
  save();
  event({ step: 'item', kind: 'item', outcome: 'started' });
  log(`${item.id} started in ${worktree}`);

  // The setup commands run until they have passed in this worktree: in a new one, and again after a setup that
  // failed, or the team would be sent to build on dependencies that were never installed.
  if (!st.setup && project.commands.setup?.length) {
    const setup = runChecks(worktree, project.commands.setup, policy.sandbox);
    event({ step: 'setup', kind: 'checks', outcome: setup.every((r) => r.ok) ? 'passed' : 'failed' });
    if (!setup.every((r) => r.ok)) return finish('blocked', `setup failed:\n${formatChecks(setup)}`);
    st.setup = true;
    save();
  }

  const commands = [...(project.commands.setup ?? []), ...project.commands.check];
  const testsStep = workflow.steps.find((s): s is AgentStep => s.kind === 'agent' && s.scope === 'tests');
  const steps = workflow.steps.filter((s) => s !== testsStep);

  const callAgent = async (step: AgentStep, attempt: number, extra: Pick<ItemContext, 'feedback' | 'checks' | 'diff'>, schema?: string) => {
    const runtimeName = runtimeFor(project, step.role);
    const locked = step.scope === 'tests' ? [] : (st.tests?.files ?? []);
    // A developer on Claude Code runs the checks itself before it may finish, so a failure is fixed in the same session.
    const stop =
      step.access === 'write' && !step.scope && runtimeName === 'claude-code' && policy.check_rounds_in_session > 0 && project.commands.check.length
        ? stopHook(paths, item.id, `a${attempt}-${step.id}`, { cwd: worktree, commands: project.commands.check, sandbox: policy.sandbox, max: policy.check_rounds_in_session })
        : undefined;
    const result = await ctx.runtime(runtimeName).call({
      cwd: worktree,
      systemPrompt: systemPrompt(step.role, step.skills, paths.factory),
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
      model: modelFor(project, step.role),
      schema: schema ? vendorSchema(schema) : step.output === 'verdict' ? vendorSchema('verdict') : undefined,
      allowedCommands: commands,
      deniedCommands: policy.denied_commands,
      protectedPaths: [...policy.protected_paths, ...locked],
      writeOnly: step.scope === 'tests' ? policy.test_paths : undefined,
      sandbox: policy.sandbox,
      hooks: stop?.hooks,
    });
    if (result.transcript) saveTranscript(paths.runs, item.id, `a${attempt}-${step.id}`, result.transcript);
    st.tokens += budgetTokens(result.tokens);
    event({
      attempt,
      step: step.id,
      kind: 'agent',
      role: step.role,
      runtime: runtimeName,
      model: modelFor(project, step.role),
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

  // A high-risk item gets the tech lead's plan before anything is written. The build follows it at once, unless the
  // plan needs a decision that is the owner's: then it waits for them.
  if (item.risk === 'high' && !st.plan?.approved) {
    if (st.tokens >= policy.max_tokens_per_item) return finish('blocked', `token budget per item reached (${st.tokens})`);
    const { result, runtimeName } = await callAgent(PLAN_STEP, 1, { feedback: st.feedback }, 'plan');
    if (!result.ok) return stopped(result, runtimeName, 'plan');
    const errors = validate('plan', result.structured);
    if (errors.length) return finish('blocked', `plan returned an invalid plan: ${errors.join('; ')}`);
    const plan = result.structured as Plan;
    st.plan = { text: formatPlan(plan) };
    st.feedback = undefined;
    if (plan.owner_decisions?.length) return finish('plan-review', `the plan needs your decision: ${plan.owner_decisions.join('; ')}`);
    st.plan.approved = new Date().toISOString();
    st.plan.by = 'tech-lead';
    save();
    event({ step: 'plan', kind: 'item', outcome: 'plan approved', detail: 'by the tech lead; nothing in it is the owner\'s to decide' });
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
    if (files.length && commitAll(worktree, `${subject(item, `test: acceptance tests for ${item.title}`)}\n\nBacklog: ${item.id}\n`)) {
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
    // Whether the tech lead passed this attempt, and what a reviewer left for the owner to decide.
    let reviewed = false;
    const escalated: string[] = [];

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

      if (!specialistOn(step, project)) continue;
      if (step.when && !stepApplies(step, item, stageAndList(worktree, base), policy, project)) {
        log(`${item.id} attempt ${attempt} ${step.id}: not needed for this change`);
        continue;
      }
      // The budget stops a new build, never the review of one that is done: its reviews are the cheap part, and
      // blocking there throws away work that already passed the checks.
      if (step.access === 'write' && st.tokens >= policy.max_tokens_per_item) return finish('blocked', `token budget per item reached (${st.tokens})`);
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
        // A change without tests written first must not reach a sensitive path: built again, tests first.
        const sensitive = !testsStep && !ctx.workflow ? changed.filter((f) => matchesAny(f, policy.sensitive_paths)) : [];
        if (sensitive.length) {
          let feature: Workflow;
          try {
            feature = testedFeature(paths, `a change to ${sensitive.join(', ')}`);
          } catch (err) {
            return finish('blocked', (err as Error).message);
          }
          git(worktree, ['reset', '-q', '--hard', base]);
          git(worktree, ['clean', '-q', '-fd']);
          st.feedback = undefined;
          save();
          event({ attempt, step: step.id, kind: 'item', outcome: 'escalated', detail: `${workflow.name} touched ${sensitive.join(', ')}; built again through ${feature.name}` });
          log(`${item.id} touched sensitive paths in ${workflow.name}; building it again through ${feature.name}, tests first`);
          return buildItem(ctx, item, feature);
        }
        st.summary = result.text.slice(0, 4000);
      }

      if (step.output === 'verdict') {
        const errors = validate('verdict', result.structured);
        if (errors.length) return finish('blocked', `${step.id} returned an invalid verdict: ${errors.join('; ')}`);
        const v = result.structured as Verdict;
        failed = verdictFails(v, step.id === 'verify' ? 'QA' : `Review by the ${step.role}`);
        if (failed) break;
        if (step.role === 'tech-lead') reviewed = true;
        escalated.push(...(v.escalate ?? []).map((e) => `${step.role}: ${e}`));
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
      // Anything flagged waits for the owner instead of merging on its own: what cannot be undone,
      // and what a reviewer left for them. A workflow without the tech lead's review leaves the owner the review of
      // approval and sensitive paths, and of high-risk items.
      const flags = [...changed.filter((f) => matchesAny(f, policy.owner_paths)), ...escalated];
      // With dev deploying itself, a change to what runs with its credentials would run at once: the owner says when.
      if (project.dev_deploy) flags.push(...changed.filter((f) => !flags.includes(f) && matchesAny(f, policy.deploy_paths)));
      if (!reviewed) {
        flags.push(...changed.filter((f) => !flags.includes(f) && (matchesAny(f, policy.approval_paths) || matchesAny(f, policy.sensitive_paths))));
        if (item.risk === 'high') flags.push('risk: high');
      }
      commitAll(worktree, `${subject(item, `feat: ${item.title}`)}\n\nBacklog: ${item.id}\n\n${st.summary ?? ''}`.trim() + '\n');
      st.feedback = undefined;
      return finish('review', undefined, flags);
    }
    feedback = failed;
    st.feedback = failed;
    save();
    event({ attempt, step: 'attempt', kind: 'item', outcome: 'failed', detail: failed.slice(0, 4000) });
  }
  return escalate(`still failing after ${policy.max_attempts} attempts`);

  /**
   * Out of attempts, the item goes up the team before it reaches the owner. The tech lead finds the cause and plans it
   * again, once, with a fresh set of attempts. When the requirement is the problem, or the new plan fails too, the
   * product owner splits it into smaller items with the same scope, or asks the owner what the product should do.
   */
  async function escalate(why: string): Promise<ItemOutcome> {
    const events = readEvents(paths.runs).filter((e) => e.item === item.id);
    const history = events
      .filter((e) => e.step === 'attempt' && e.outcome === 'failed')
      .slice(-6)
      .map((e) => `Attempt ${e.attempt}:\n${(e.detail ?? '').slice(0, 1500)}`)
      .join('\n\n');
    if (st.tokens >= policy.max_tokens_per_item) return finish('blocked', `${why}; token budget per item reached (${st.tokens})`);
    if (!st.escalated) {
      const { result, runtimeName } = await callAgent(DIAGNOSE_STEP, policy.max_attempts, { feedback: `It kept failing:\n\n${history}` }, 'diagnosis');
      if (!result.ok) return stopped(result, runtimeName, 'diagnose');
      const d = result.structured as Diagnosis;
      if (validate('diagnosis', d).length) return finish('blocked', `${why}; the tech lead's diagnosis was not valid`);
      st.escalated = 'tech-lead';
      if (d.cause === 'code' && d.plan?.trim()) {
        st.plan = { text: d.plan, approved: new Date().toISOString(), by: 'tech-lead' };
        st.feedback = `The tech lead looked at why it kept failing: ${d.diagnosis}\n\nFollow the new plan.`;
        st.state = 'rework';
        save();
        event({ step: 'diagnose', kind: 'item', outcome: 'replanned', detail: d.diagnosis });
        log(`${item.id}: the tech lead planned it again: ${d.diagnosis}`);
        return runItem(ctx, item, workflow);
      }
      event({ step: 'diagnose', kind: 'item', outcome: 'to the product owner', detail: d.diagnosis });
      log(`${item.id}: the tech lead hands it to the product owner: ${d.diagnosis}`);
    }
    if (st.escalated !== 'tech-lead') return finish('blocked', why);

    const diagnosis = readEvents(paths.runs).filter((e) => e.item === item.id && e.step === 'diagnose').at(-1)?.detail ?? '';
    const { result, runtimeName } = await callAgent(RESCOPE_STEP, policy.max_attempts, { feedback: `The tech lead's diagnosis: ${diagnosis}\n\nWhat went wrong:\n\n${history}` }, 'rescope');
    if (!result.ok) return stopped(result, runtimeName, 'rescope');
    const r = result.structured as Rescope;
    if (validate('rescope', r).length) return finish('blocked', `${why}; the product owner's decision was not valid`);
    st.escalated = 'product-owner';
    if (r.decision === 'split' && (r.items?.length ?? 0) >= 2) return split(r);
    st.escalated = 'owner';
    if (!r.question) return finish('blocked', `${why}: ${r.reason}`);
    const options = r.options?.length ? ` Options: ${r.options.join(' / ')}.` : '';
    const recommended = r.recommended ? ` Recommended: ${r.recommended}.` : '';
    return finish('blocked', `the team needs your decision: ${r.question}${options}${recommended} (${r.reason})`);
  }

  /** The product owner's split: smaller ready items, built in order, and the item itself parked as a draft. */
  function split(r: Rescope): ItemOutcome {
    if (currentBranch(paths.root) !== baseBranch) return finish('blocked', `the product owner would split it, but the backlog is written on ${baseBranch}: check it out, then \`asf decide ${item.id} retry\`. ${r.reason}`);
    const { items } = loadBacklog(paths.backlog);
    let n = Math.max(0, ...items.map((i) => Number(i.id.slice(2))));
    const files: string[] = [];
    const ids: string[] = [];
    for (const [k, part] of r.items!.entries()) {
      n++;
      const id = `B-${String(n).padStart(4, '0')}`;
      const deps = k === 0 ? (item.depends_on ?? []) : [ids[k - 1]!];
      const out = join(paths.backlog, `${String(n).padStart(4, '0')}-${item.id.toLowerCase()}-part-${k + 1}.md`);
      writeFileSync(
        out,
        `---\nid: ${id}\ntitle: ${JSON.stringify(part.title)}\nstatus: ready\npriority: ${item.priority ?? n}\n${deps.length ? `depends_on: [${deps.join(', ')}]\n` : ''}${item.tracker ? `tracker: ${item.tracker}\n` : ''}---\n${part.body.trim()}\n\nSplit from ${item.id} by the product owner: ${r.reason}\n`,
      );
      files.push(out);
      ids.push(id);
    }
    const own = items.find((i) => i.id === item.id);
    if (own) {
      setStatus(own.file, 'draft');
      writeFileSync(own.file, `${readFileSync(own.file, 'utf8').trimEnd()}\n\nSplit into ${ids.join(', ')} by the product owner: ${r.reason}\n`);
      files.push(own.file);
    }
    commitFiles(paths.root, files, `${subject(item, `chore(backlog): split ${item.id} into ${ids.join(', ')}`)}\n`);
    removeWorktree(paths.root, worktree, branch);
    const all = loadState(paths.state);
    delete all.items[item.id];
    saveState(paths.state, all);
    const reason = `split into ${ids.join(', ')}: ${r.reason}`;
    event({ step: 'rescope', kind: 'item', outcome: 'split', detail: reason });
    log(`${item.id} ${reason}`);
    return { id: item.id, state: 'split', reason, tokens: st.tokens, flags: [] };
  }
}
