import type { RuntimeName, SandboxPolicy } from '../config.js';
import type { Tokens } from '../runlog.js';

export interface AgentCall {
  cwd: string;
  /** Role and skills. Stable across items, so it goes first and can be cached. */
  systemPrompt: string;
  /** The item, its spec, project memory and any feedback. */
  prompt: string;
  access: 'read' | 'write';
  model?: string;
  /** JSON Schema the final answer must follow. */
  schema?: object;
  /** Command prefixes the agent may run (write access only). */
  allowedCommands: string[];
  deniedCommands: string[];
  protectedPaths: string[];
  /** With write access, the only paths the agent may edit, for example a tests step. The runner checks it too. */
  writeOnly?: string[];
  /** Run the agent's commands in the sandbox. Unset only in tests and when the operator turned it off. */
  sandbox?: SandboxPolicy;
  /** Claude Code hooks, for example a Stop hook that runs the checks before the agent may finish. */
  hooks?: object;
  timeoutMs?: number;
}

export interface RateLimit {
  /** "allowed" while work can go on. */
  status: string;
  /** Unix seconds. */
  resetsAt?: number;
  /** 0 to 1, for the window that is closest to its limit. */
  utilization?: number;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  tokens: Tokens;
  costUsd?: number;
  durationMs: number;
  error?: string;
  /** Tool calls the CLI refused, for example a command outside the allowed list. */
  denied?: string[];
  /** Everything the CLI printed as events, kept for error analysis. */
  transcript?: string;
  rateLimit?: RateLimit;
}

export interface InteractiveCall {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  model?: string;
}

export interface Runtime {
  name: RuntimeName;
  call(c: AgentCall): Promise<AgentResult>;
  /** Hands the terminal to the CLI for a session with the user. Resolves to its exit code. */
  interactive(c: InteractiveCall): Promise<number>;
}

export const noTokens = (): Tokens => ({ input: 0, cached_input: 0, output: 0, total: 0 });
