import { join } from 'node:path';
import type { BacklogItem } from './backlog.js';
import { formatChecks, runChecks } from './checks.js';
import { loadSchema, runtimeFor, validate, type Policy, type ProjectConfig, type RuntimeName } from './config.js';
import { commitAll, ensureWorktree, git, restorePaths, stagedDiff, stageAndList } from './git.js';
import { matchesAny } from './glob.js';
import { findSecrets, testTampering } from './integrity.js';
import type { ProductPaths } from './paths.js';
import { itemPrompt, systemPrompt } from './prompt.js';
import { appendEvent, saveTranscript, type RunEvent } from './runlog.js';
import type { Runtime } from './runtimes/types.js';
import { loadState, saveState, type ItemState } from './state.js';
import { loadWorkflow, type Workflow } from './workflow.js';

export interface EngineContext {
  paths: ProductPaths;
  project: ProjectConfig;
  policy: Policy;
  runtime: (name: RuntimeName) => Runtime;
  log?: (msg: string) => void;
}

export interface ItemOutcome {
  id: string;
  state: 'review' | 'blocked';
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

/** Vendor structured-output modes reject some JSON Schema keywords, so the schema is sent without them. */
function verdictSchema(): object {
  const { $schema: _s, $id: _i, title: _t, ...rest } = loadSchema('verdict') as Record<string, unknown>;
  return rest;
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

export async function runItem(ctx: EngineContext, item: BacklogItem, workflow: Workflow = loadWorkflow('feature')): Promise<ItemOutcome> {
  const { paths, project, policy } = ctx;
  const base = project.base_branch ?? 'main';
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
  const finish = (state: ItemOutcome['state'], reason?: string, flags: string[] = []): ItemOutcome => {
    st.state = state;
    st.reason = reason;
    st.flags = flags;
    save();
    event({ step: 'item', kind: 'item', outcome: state, detail: reason });
    log(`${item.id} ${state}${reason ? `: ${reason}` : ''}`);
    return { id: item.id, state, reason, tokens: st.tokens, flags };
  };

  const fresh = !prev;
  ensureWorktree(paths.root, worktree, branch, base);
  save();
  event({ step: 'item', kind: 'item', outcome: 'started' });
  log(`${item.id} started in ${worktree}`);

  if (fresh && project.commands.setup?.length) {
    const setup = runChecks(worktree, project.commands.setup, policy.sandbox);
    event({ step: 'setup', kind: 'checks', outcome: setup.every((r) => r.ok) ? 'passed' : 'failed' });
    if (!setup.every((r) => r.ok)) return finish('blocked', `setup failed:\n${formatChecks(setup)}`);
  }

  const commands = [...(project.commands.setup ?? []), ...project.commands.check];
  let feedback = st.feedback;
  for (let attempt = 1; attempt <= policy.max_attempts; attempt++) {
    st.attempts = attempt;
    let checksText: string | undefined;
    let failed: string | undefined;

    for (const step of workflow.steps) {
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
      const runtimeName = runtimeFor(project, step.role);
      const runtime = ctx.runtime(runtimeName);
      const diff = step.access === 'read' ? (stageAndList(worktree, base), stagedDiff(worktree, base, 60_000)) : undefined;
      const result = await runtime.call({
        cwd: worktree,
        systemPrompt: systemPrompt(step.role, step.skills),
        prompt: itemPrompt({
          root: worktree,
          project,
          item,
          attempt,
          maxAttempts: policy.max_attempts,
          feedback: step.access === 'write' ? feedback : undefined,
          checks: step.access === 'read' ? checksText : undefined,
          diff,
        }),
        access: step.access,
        model: project.models?.[step.role],
        schema: step.output === 'verdict' ? verdictSchema() : undefined,
        allowedCommands: commands,
        deniedCommands: policy.denied_commands,
        protectedPaths: policy.protected_paths,
        sandbox: policy.sandbox,
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
      // A runtime error is usually a limit or a sign-in problem; retrying would only burn tokens.
      if (!result.ok) return finish('blocked', `${runtimeName} failed in ${step.id}: ${result.error}`);

      if (step.access === 'write') {
        const changed = stageAndList(worktree, base);
        const touched = changed.filter((f) => matchesAny(f, policy.protected_paths));
        if (touched.length) {
          restorePaths(worktree, base, touched);
          failed = `You changed protected files. They were put back; do not change them: ${touched.join(', ')}`;
          break;
        }
        if (!changed.length) {
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
      const late = changed.filter((f) => matchesAny(f, policy.protected_paths));
      if (late.length) {
        restorePaths(worktree, base, late);
        return finish('blocked', `protected files changed outside a build step: ${late.join(', ')}`);
      }
      const secrets = findSecrets(git(worktree, ['diff', '--cached', '-U0', base]), policy.secret_patterns);
      if (secrets.length) {
        failed = `The change contains what looks like a secret. Remove it; credentials never go into the repository:\n${secrets.map((x) => `- ${x}`).join('\n')}`;
      }
    }

    if (!failed) {
      const changed = stageAndList(worktree, base);
      const flags = changed.filter((f) => matchesAny(f, policy.approval_paths));
      commitAll(worktree, `feat: ${item.title}\n\nBacklog: ${item.id}\n\n${st.summary ?? ''}`.trim() + '\n');
      st.feedback = undefined;
      return finish('review', undefined, flags);
    }
    feedback = failed;
    st.feedback = failed;
    save();
  }
  return finish('blocked', `still failing after ${policy.max_attempts} attempts`);
}
