#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatChecks, runChecks } from '../checks.js';
import type { SandboxPolicy } from '../config.js';

/** Written by the runner outside the worktree, so the agent cannot change it. */
export interface StopHookConfig {
  cwd: string;
  commands: string[];
  sandbox?: SandboxPolicy;
  /** Times the agent may be sent back before it is let go; the runner's own checks still decide. */
  max: number;
  /** Where the rounds are counted. */
  counter: string;
}

export interface StopHookCount {
  rounds: number;
  blocked: number;
  passed: boolean;
}

/**
 * Claude Code's Stop hook for build steps: when the builder wants to finish, the product's checks run, sandboxed and
 * without secrets, as the runner runs them. A failure sends the builder back with the output, in the same session,
 * so it is fixed with everything the builder already knows. After `max` rounds the builder is let go and the runner's
 * check step decides as before; nothing here can let a failing item through.
 */
export function stopCheck(cfg: StopHookConfig): { block: boolean; reason?: string; count: StopHookCount } {
  let count: StopHookCount = { rounds: 0, blocked: 0, passed: false };
  try {
    count = JSON.parse(readFileSync(cfg.counter, 'utf8')) as StopHookCount;
  } catch {
    // The first round.
  }
  if (count.blocked >= cfg.max) return { block: false, count };
  count.rounds++;
  const results = runChecks(cfg.cwd, cfg.commands, cfg.sandbox);
  count.passed = results.every((r) => r.ok);
  if (!count.passed) count.blocked++;
  writeFileSync(cfg.counter, JSON.stringify(count) + '\n');
  if (count.passed) return { block: false, count };
  return {
    block: true,
    count,
    reason: `Before you finish: the checks failed (round ${count.blocked} of ${cfg.max}). Fix the code, not the tests, then finish again.\n\n${formatChecks(results)}`,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as StopHookConfig;
  const r = stopCheck(cfg);
  if (r.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: r.reason }));
  process.exit(0);
}
