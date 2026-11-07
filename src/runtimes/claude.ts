import { claudeSandbox, prepareWritable, sandboxOff, toolchainEnv } from '../sandbox.js';
import { exec, interactive, tail } from './exec.js';
import { noTokens, type AgentCall, type AgentResult, type RateLimit, type Runtime } from './types.js';

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];
const WRITE_TOOLS = ['Edit', 'Write'];

interface ClaudeJson {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  permission_denials?: { tool_name?: string; tool_input?: { command?: string; file_path?: string } }[];
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
    const write = c.writeOnly ? c.writeOnly.flatMap((g) => WRITE_TOOLS.map((t) => `${t}(${g})`)) : WRITE_TOOLS;
    allowed.push(...write, ...c.allowedCommands.map((cmd) => `Bash(${cmd}:*)`));
  }
  const sandbox = c.sandbox && !sandboxOff() ? c.sandbox : undefined;
  const denied = [
    ...c.deniedCommands.map((cmd) => `Bash(${cmd}:*)`),
    ...c.protectedPaths.flatMap((p) => [`Edit(${p})`, `Write(${p})`]),
    // The Read tool is not sandboxed, so the paths the sandbox hides are denied to it as well.
    ...(sandbox?.deny_read ?? []).flatMap((p) => [`Read(${p})`, `Read(${p}/**)`]),
  ];
  const settings: Record<string, object> = {};
  if (sandbox) {
    settings.sandbox = claudeSandbox(sandbox);
    settings.env = toolchainEnv(sandbox);
  }
  if (c.hooks) settings.hooks = c.hooks;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--permission-mode', 'dontAsk',
    '--append-system-prompt', c.systemPrompt,
  ];
  if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));
  if (c.model) args.push('--model', c.model);
  if (c.schema) args.push('--json-schema', JSON.stringify(c.schema));
  args.push('--allowedTools', allowed.join(','));
  if (denied.length) args.push('--disallowedTools', denied.join(','));
  return args;
}

interface RateLimitEvent {
  type?: string;
  rate_limit_info?: { status?: string; resetsAt?: number; unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }> };
}

/** The tightest window of the subscription's limits, from the last rate_limit_event in the stream. */
export function parseRateLimit(lines: unknown[]): RateLimit | undefined {
  const ev = lines.filter((l): l is RateLimitEvent => (l as RateLimitEvent)?.type === 'rate_limit_event').at(-1)?.rate_limit_info;
  if (!ev) return undefined;
  const windows = Object.values(ev.unifiedWindows ?? {});
  const tight = windows.sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0];
  return { status: ev.status ?? 'unknown', resetsAt: ev.resetsAt ?? tight?.resetsAt, utilization: tight?.utilization };
}

/** Reads `--output-format stream-json` (one event per line, the result last) or a single JSON result. */
export function parseClaudeOutput(stdout: string): Omit<AgentResult, 'durationMs'> {
  const lines: unknown[] = [];
  for (const l of stdout.split('\n')) {
    if (!l.trim().startsWith('{')) continue;
    try {
      lines.push(JSON.parse(l));
    } catch {
      // A partial line, for example after a timeout.
    }
  }
  const data = (lines.filter((l) => (l as { type?: string }).type === 'result').at(-1) ?? (lines.length === 1 ? lines[0] : undefined)) as
    | ClaudeJson
    | undefined;
  const rateLimit = parseRateLimit(lines);
  if (!data) return { ok: false, text: '', tokens: noTokens(), rateLimit, error: `unreadable output: ${tail(stdout, 500)}` };
  const u = data.usage ?? {};
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const cached = u.cache_read_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const tokens = { input, cached_input: cached, output, total: input + cached + output };
  const ok = !data.is_error && data.subtype !== 'error';
  const denied = (data.permission_denials ?? []).map((d) => `${d.tool_name ?? '?'}: ${d.tool_input?.command ?? d.tool_input?.file_path ?? ''}`.trim());
  return {
    ok,
    text: data.result ?? '',
    structured: data.structured_output,
    tokens,
    costUsd: data.total_cost_usd,
    denied: denied.length ? denied : undefined,
    rateLimit,
    error: ok ? undefined : tail(data.result ?? data.subtype ?? 'unknown error', 1000),
  };
}

export const claudeCode: Runtime = {
  name: 'claude-code',
  async call(c) {
    if (c.sandbox && !sandboxOff()) prepareWritable(c.sandbox);
    const r = await exec('claude', claudeArgs(c), { cwd: c.cwd, input: c.prompt, timeoutMs: c.timeoutMs ?? 30 * 60_000 });
    if (r.timedOut) return { ok: false, text: '', tokens: noTokens(), durationMs: r.durationMs, error: 'timed out' };
    const parsed = { ...parseClaudeOutput(r.stdout), transcript: r.stdout };
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
