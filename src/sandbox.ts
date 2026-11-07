import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxPolicy } from './config.js';

export class SandboxError extends Error {}

/**
 * The operator's explicit way out, for machines where the sandbox cannot run. It is never read from a product's
 * files, so an agent cannot switch it off.
 */
export const sandboxOff = () => process.env.ASF_UNSAFE_NO_SANDBOX === '1';

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|SESSION_?KEY/i;

/** The environment for agent commands and checks: no secrets, whatever the sandbox does. */
export function scrubEnv(env: NodeJS.ProcessEnv, secretNames: string[]): NodeJS.ProcessEnv {
  const deny = new Set(secretNames);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!deny.has(k) && !SECRET_NAME.test(k)) out[k] = v;
  return out;
}

/**
 * Variables that let common toolchains work inside the sandbox, set for checks and for agent commands alike:
 * - MSBuild's source-control queries read `.gitmodules`, which the sandbox keeps unreadable on Linux when it is
 *   absent; they only stamp commit information into build output.
 * - On macOS the sandbox matches loopback connections only on IPv4 and IPv6 addresses, not on the dual-stack
 *   sockets .NET opens by default, so `dotnet test` cannot reach its test host unless .NET uses IPv4.
 */
export function toolchainEnv(sb: SandboxPolicy): Record<string, string> {
  const env: Record<string, string> = { EnableSourceControlManagerQueries: 'false' };
  if (sb.local_binding && process.platform === 'darwin') env.DOTNET_SYSTEM_NET_DISABLEIPV6 = '1';
  return env;
}

/** Settings for Anthropic's sandbox runtime (`srt`), which wraps the runner's own checks. */
export function srtSettings(sb: SandboxPolicy): object {
  return {
    network: { allowedDomains: sb.network_allow, deniedDomains: [], allowLocalBinding: sb.local_binding },
    filesystem: { denyRead: sb.deny_read, allowWrite: ['.', tmpdir(), '/tmp', ...sb.write_allow], denyWrite: [] },
    credentials: { envVars: sb.secret_env.map((name) => ({ name, mode: 'deny' })) },
  };
}

/** The `sandbox` block of Claude Code settings: its Bash tool runs sandboxed, and refuses to run otherwise. */
export function claudeSandbox(sb: SandboxPolicy): object {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    network: { allowedDomains: sb.network_allow, allowLocalBinding: sb.local_binding },
    filesystem: { denyRead: sb.deny_read, allowWrite: [tmpdir(), ...sb.write_allow] },
    credentials: { envVars: sb.secret_env.map((name) => ({ name, mode: 'deny' })) },
  };
}

/**
 * On Linux the sandbox can only make a path writable if it exists, so the package caches are created first;
 * otherwise a first `dotnet restore` finds `~/.dotnet` read-only.
 */
export function prepareWritable(sb: SandboxPolicy): void {
  // The sandbox points TMPDIR at /tmp/claude without creating it; MSBuild then fails to make its temp folder.
  mkdirSync('/tmp/claude', { recursive: true });
  for (const p of sb.write_allow) if (p.startsWith('~/')) mkdirSync(join(homedir(), p.slice(2)), { recursive: true });
}

const settingsFiles = new Map<string, string>();
let srtChecked: boolean | undefined;
export function hasSrt(): boolean {
  srtChecked ??= spawnSync('srt', ['--version'], { encoding: 'utf8' }).status === 0;
  return srtChecked;
}

/** A command line that runs `command` in the sandbox, or as it is when the operator turned the sandbox off. */
export function sandboxed(command: string, sb: SandboxPolicy | undefined): { cmd: string; args: string[]; shell: boolean } {
  if (!sb || sandboxOff()) return { cmd: command, args: [], shell: true };
  if (!hasSrt()) {
    throw new SandboxError(
      'the sandbox runtime is not installed: `npm install -g @anthropic-ai/sandbox-runtime` (on Linux also bubblewrap and socat), or set ASF_UNSAFE_NO_SANDBOX=1 to run unsandboxed',
    );
  }
  prepareWritable(sb);
  const json = JSON.stringify(srtSettings(sb));
  let file = settingsFiles.get(json);
  if (!file) {
    file = join(mkdtempSync(join(tmpdir(), 'asf-srt-')), 'settings.json');
    writeFileSync(file, json);
    settingsFiles.set(json, file);
  }
  return { cmd: 'srt', args: ['--settings', file, '-c', command], shell: false };
}
