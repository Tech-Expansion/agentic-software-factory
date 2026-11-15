import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Runs a command with `input` on stdin, then closes stdin. Never goes through a shell. After `timeoutMs` the command
 * is asked to stop; one that has not stopped `killAfterMs` later is killed and given up on, with what it printed so
 * far, because a command of its own that keeps the output open would otherwise hold the item up for as long as it runs.
 */
export function exec(cmd: string, args: string[], opts: { cwd: string; input: string; timeoutMs: number; killAfterMs?: number; env?: NodeJS.ProcessEnv }): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const done = (code: number | null, extra = '') => {
      clearTimeout(timer);
      clearTimeout(killer);
      resolve({ code, stdout, stderr: stderr + extra, durationMs: Date.now() - started, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        done(null);
      }, opts.killAfterMs ?? 15_000);
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => done(null, err.message));
    child.on('close', (code) => done(code));
    child.stdin.end(opts.input);
  });
}

export function interactive(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export const tail = (s: string, n = 2000) => (s.length > n ? `…${s.slice(-n)}` : s);
