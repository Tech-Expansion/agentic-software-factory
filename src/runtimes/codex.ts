import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, interactive, tail } from './exec.js';
import { noTokens, type AgentCall, type AgentResult, type Runtime } from './types.js';

/** Codex has no system prompt flag, so role and skills open the prompt. */
export const codexPrompt = (c: { systemPrompt: string; prompt: string }) => `${c.systemPrompt}\n\n---\n\n${c.prompt}`;

export function codexArgs(c: AgentCall, lastMessageFile: string, schemaFile?: string): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '-C', c.cwd,
    '-s', c.access === 'write' ? 'workspace-write' : 'read-only',
    '-o', lastMessageFile,
  ];
  if (schemaFile) args.push('--output-schema', schemaFile);
  if (c.model) args.push('-m', c.model);
  args.push('-');
  return args;
}

export function parseCodexEvents(stdout: string): { tokens: AgentResult['tokens']; error?: string; lastText: string } {
  const tokens = noTokens();
  let error: string | undefined;
  let lastText = '';
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: { type?: string; usage?: Record<string, number>; item?: { type?: string; text?: string }; message?: string; error?: { message?: string } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      const cached = ev.usage.cached_input_tokens ?? 0;
      const input = (ev.usage.input_tokens ?? 0) - cached;
      const output = (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0);
      tokens.input += input;
      tokens.cached_input += cached;
      tokens.output += output;
      tokens.total += input + cached + output;
    } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
      lastText = ev.item.text ?? lastText;
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      error = ev.error?.message ?? ev.message ?? 'codex reported an error';
    }
  }
  return { tokens, error, lastText };
}

export const codex: Runtime = {
  name: 'codex',
  async call(c) {
    const dir = mkdtempSync(join(tmpdir(), 'asf-codex-'));
    try {
      const last = join(dir, 'last.txt');
      let schemaFile: string | undefined;
      if (c.schema) {
        schemaFile = join(dir, 'schema.json');
        writeFileSync(schemaFile, JSON.stringify(c.schema));
      }
      const r = await exec('codex', codexArgs(c, last, schemaFile), { cwd: c.cwd, input: codexPrompt(c), timeoutMs: c.timeoutMs ?? 30 * 60_000 });
      const ev = parseCodexEvents(r.stdout);
      const text = existsSync(last) ? readFileSync(last, 'utf8').trim() : ev.lastText;
      if (r.timedOut) return { ok: false, text, tokens: ev.tokens, durationMs: r.durationMs, error: 'timed out' };
      const error = ev.error ?? (r.code === 0 ? undefined : `exit ${r.code}: ${tail(r.stderr, 1000)}`);
      let structured: unknown;
      if (c.schema && !error) {
        try {
          structured = JSON.parse(text);
        } catch {
          return { ok: false, text, tokens: ev.tokens, durationMs: r.durationMs, error: 'final message is not JSON' };
        }
      }
      return { ok: !error, text, structured, tokens: ev.tokens, durationMs: r.durationMs, error };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  interactive(c) {
    const args = c.model ? ['-m', c.model] : [];
    args.push(codexPrompt(c));
    return interactive('codex', args, c.cwd);
  },
};
