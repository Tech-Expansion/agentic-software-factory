import { exec, interactive, tail } from './exec.js';
import { noTokens, type AgentCall, type AgentResult, type Runtime } from './types.js';

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];
const WRITE_TOOLS = ['Edit', 'Write'];

interface ClaudeJson {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

/** Builds the argument list. Exported for tests; see ADR 0003 for why each flag is there. */
export function claudeArgs(c: AgentCall): string[] {
  const allowed = [...READ_TOOLS];
  if (c.access === 'write') {
    allowed.push(...WRITE_TOOLS, ...c.allowedCommands.map((cmd) => `Bash(${cmd}:*)`));
  }
  const denied = [
    ...c.deniedCommands.map((cmd) => `Bash(${cmd}:*)`),
    ...c.protectedPaths.flatMap((p) => [`Edit(${p})`, `Write(${p})`]),
  ];
  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--permission-mode', 'dontAsk',
    '--append-system-prompt', c.systemPrompt,
  ];
  if (c.model) args.push('--model', c.model);
  if (c.schema) args.push('--json-schema', JSON.stringify(c.schema));
  args.push('--allowedTools', allowed.join(','));
  if (denied.length) args.push('--disallowedTools', denied.join(','));
  return args;
}

export function parseClaudeOutput(stdout: string): Omit<AgentResult, 'durationMs'> {
  let data: ClaudeJson;
  try {
    data = JSON.parse(stdout) as ClaudeJson;
  } catch {
    return { ok: false, text: '', tokens: noTokens(), error: `unreadable output: ${tail(stdout, 500)}` };
  }
  const u = data.usage ?? {};
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const cached = u.cache_read_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const tokens = { input, cached_input: cached, output, total: input + cached + output };
  const ok = !data.is_error && data.subtype !== 'error';
  return {
    ok,
    text: data.result ?? '',
    structured: data.structured_output,
    tokens,
    costUsd: data.total_cost_usd,
    error: ok ? undefined : tail(data.result ?? data.subtype ?? 'unknown error', 1000),
  };
}

export const claudeCode: Runtime = {
  name: 'claude-code',
  async call(c) {
    const r = await exec('claude', claudeArgs(c), { cwd: c.cwd, input: c.prompt, timeoutMs: c.timeoutMs ?? 30 * 60_000 });
    if (r.timedOut) return { ok: false, text: '', tokens: noTokens(), durationMs: r.durationMs, error: 'timed out' };
    const parsed = parseClaudeOutput(r.stdout);
    if (r.code !== 0 && parsed.ok) {
      return { ...parsed, ok: false, durationMs: r.durationMs, error: `exit ${r.code}: ${tail(r.stderr, 1000)}` };
    }
    return { ...parsed, durationMs: r.durationMs, error: parsed.error ?? (r.code === 0 ? undefined : tail(r.stderr, 1000)) };
  },
  interactive(c) {
    const args = ['--append-system-prompt', c.systemPrompt];
    if (c.model) args.push('--model', c.model);
    args.push(c.prompt);
    return interactive('claude', args, c.cwd);
  },
};
