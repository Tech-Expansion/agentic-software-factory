import { spawnSync } from 'node:child_process';
import { tail } from './runtimes/exec.js';

export interface CheckResult {
  command: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

/** Runs the product's own commands in order and stops at the first failure. No model is involved. */
export function runChecks(cwd: string, commands: string[], timeoutMs = 15 * 60_000): CheckResult[] {
  const results: CheckResult[] = [];
  for (const command of commands) {
    const started = Date.now();
    const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
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
