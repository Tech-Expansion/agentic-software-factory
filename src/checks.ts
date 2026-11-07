import { spawnSync } from 'node:child_process';
import type { SandboxPolicy } from './config.js';
import { tail } from './runtimes/exec.js';
import { sandboxed, sandboxOff, scrubEnv, toolchainEnv } from './sandbox.js';

export interface CheckResult {
  command: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

/**
 * Runs the product's own commands in order and stops at the first failure. No model is involved, but the commands
 * run code the agents wrote, so they get no secrets in their environment and, with a sandbox policy, run in the
 * sandbox.
 */
export function runChecks(cwd: string, commands: string[], sandbox?: SandboxPolicy, timeoutMs = 15 * 60_000): CheckResult[] {
  const results: CheckResult[] = [];
  const env = { ...scrubEnv(process.env, sandbox?.secret_env ?? []), ...(sandbox && !sandboxOff() ? toolchainEnv(sandbox) : {}) };
  for (const command of commands) {
    const started = Date.now();
    const { cmd, args, shell } = sandboxed(command, sandbox);
    const r = spawnSync(cmd, args, { cwd, shell, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    const ok = r.status === 0;
    results.push({ command, ok, output: tail(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), 4000), durationMs: Date.now() - started });
    if (!ok) break;
  }
  return results;
}

export function formatChecks(results: CheckResult[]): string {
  return results
    .map((r) => `- \`${r.command}\`: ${r.ok ? 'passed' : 'FAILED'}${r.ok ? '' : `\n\n\`\`\`\n${r.output}\n\`\`\``}`)
    .join('\n');
}
