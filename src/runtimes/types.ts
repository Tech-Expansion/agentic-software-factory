import type { RuntimeName } from '../config.js';
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
  timeoutMs?: number;
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
